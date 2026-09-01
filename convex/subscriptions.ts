import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { action, internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  getActiveSubscriptionTier,
  getEntitlementSubscriptionTier,
  getTierMaxVideoDurationMs,
  handleTierDowngrade,
  handleTierUpgrade,
  processExpiredReclaims as processExpiredReclaimsImpl,
  reclaimFrozenCamps,
  type SubscriptionTier,
  TIER_RANK,
  tierCanCreateBondfires,
} from './entitlements'
import {
  assertStoreAccountOwnership,
  nextStoreSyncAt,
  type StoreLifecycleState,
  selectStoreRecordForUser,
} from './lib/storeBillingPolicy'

type SubscriptionPlatform = 'ios' | 'android'
type StorePurchaseKind = 'subscription' | 'consumable'
type VerifiedStoreStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
type StoreSyncStatus = 'pending_verification' | VerifiedStoreStatus

const storeStatusValidator = v.union(
  v.literal('pending_verification'),
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('expired'),
)

const storePurchaseKindValidator = v.union(v.literal('subscription'), v.literal('consumable'))
const storeLifecycleValidator = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('trialing'),
  v.literal('grace_period'),
  v.literal('billing_retry'),
  v.literal('canceled'),
  v.literal('paused'),
  v.literal('on_hold'),
  v.literal('expired'),
  v.literal('refunded'),
  v.literal('revoked'),
)

const PRODUCT_ID_TO_TIER: Record<string, SubscriptionTier | undefined> = {
  'bondfires.plus.monthly': 'plus',
  'bondfires.plus.annual': 'plus',
  'bondfires.premium.monthly': 'premium',
  'bondfires.premium.annual': 'premium',
  'bondfires.pro.monthly': 'pro',
  'bondfires.pro.annual': 'pro',
}

/** Product IDs matching consumable kindling pack purchases. */
const CONSUMABLE_PRODUCT_PATTERN = /^bondfires\.camp_slots\./

function getStorePurchaseKind(storeProductId: string): StorePurchaseKind | null {
  if (PRODUCT_ID_TO_TIER[storeProductId]) {
    return 'subscription'
  }

  if (CONSUMABLE_PRODUCT_PATTERN.test(storeProductId)) {
    return 'consumable'
  }

  return null
}

function assertStoreProductMatchesKind(storeProductId: string, kind: StorePurchaseKind) {
  if (getStorePurchaseKind(storeProductId) !== kind) {
    throw new Error(
      `Verified store product does not match requested purchase kind: ${storeProductId}`,
    )
  }
}

function getTierForStoreProduct(storeProductId: string) {
  return PRODUCT_ID_TO_TIER[storeProductId] ?? null
}

function getStoreOriginalTransactionId(args: {
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
}) {
  return args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken
}

function assertStoreIdentifiers(args: {
  platform: SubscriptionPlatform
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
}) {
  for (const identifier of [
    args.storeTransactionId,
    args.storeOriginalTransactionId,
    args.storePurchaseToken,
  ]) {
    if (identifier && identifier.length > 4_096) {
      throw new Error('Store purchase identifier is too long')
    }
  }
  if (args.platform === 'android' && !args.storePurchaseToken) {
    throw new Error('Android purchases require a store purchase token')
  }

  if (args.platform === 'ios' && !args.storeOriginalTransactionId && !args.storeTransactionId) {
    throw new Error('iOS purchases require a store transaction identifier')
  }
}

function getVerifiedSyncStatus(existing?: {
  status?: string
  verificationStatus?: string
}): StoreSyncStatus {
  // Subscriptions have a lifecycle status in addition to verification state.
  if (existing?.verificationStatus === 'verified' && existing.status) {
    switch (existing.status) {
      case 'active':
      case 'trialing':
      case 'past_due':
      case 'canceled':
      case 'expired':
        return existing.status
    }
  }

  // Consumable purchases are verified once and have no lifecycle status.
  if (existing?.verificationStatus === 'verified' && existing.status === undefined) {
    return 'active'
  }

  return 'pending_verification'
}

function isVerifiedActiveStoreRecord(existing?: { status?: string; verificationStatus?: string }) {
  return getVerifiedSyncStatus(existing) !== 'pending_verification'
}

function isRefundedStoreRecord(existing?: { verificationStatus?: string } | null) {
  return existing?.verificationStatus === 'refunded'
}

function getVerificationStateForStatus(status: StoreSyncStatus): 'pending' | 'verified' {
  return status === 'pending_verification' ? 'pending' : 'verified'
}

function statusUnlocksEntitlements(status: StoreSyncStatus) {
  return status === 'active' || status === 'trialing'
}

async function wasRetainedForDeletedAccount(
  ctx: MutationCtx,
  args: {
    storeTransactionId?: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeTransactionId) {
    const row = await ctx.db
      .query('deletedAccountPurchaseRecords')
      .withIndex('by_transaction', (q) => q.eq('storeTransactionId', args.storeTransactionId))
      .first()
    if (row) return true
  }
  if (args.storeOriginalTransactionId) {
    const row = await ctx.db
      .query('deletedAccountPurchaseRecords')
      .withIndex('by_original_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .first()
    if (row) return true
  }
  if (args.storePurchaseToken) {
    const row = await ctx.db
      .query('deletedAccountPurchaseRecords')
      .withIndex('by_purchase_token', (q) => q.eq('storePurchaseToken', args.storePurchaseToken))
      .first()
    if (row) return true
  }
  return false
}

function lifecycleStateForStatus(status: StoreSyncStatus): StoreLifecycleState {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'billing_retry'
    case 'canceled':
      return 'canceled'
    case 'expired':
      return 'expired'
    default:
      return 'pending'
  }
}

async function findExistingSubscription(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
    includePendingFallback?: boolean
  },
) {
  if (args.storeOriginalTransactionId) {
    const byOriginalTransactions = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .collect()
    const byOriginalTransaction = selectStoreRecordForUser(byOriginalTransactions, args.userId)
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const byPurchaseTokens = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_purchase_token', (q) =>
        q.eq('storePurchaseToken', args.storePurchaseToken),
      )
      .collect()
    const byPurchaseToken = selectStoreRecordForUser(byPurchaseTokens, args.userId)
    if (byPurchaseToken) return byPurchaseToken
  }

  if (args.includePendingFallback === false) return null
  const pendingSubscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'pending_verification'))
    .collect()

  return (
    pendingSubscriptions.find(
      (subscription) => subscription.storeProductId === args.storeProductId,
    ) ?? null
  )
}

function getKindlingQuantityForProduct(storeProductId: string): number {
  // Product IDs: bondfires.camp_slots.3pack, bondfires.camp_slots.10pack
  const packMap: Record<string, number> = {
    'bondfires.camp_slots.3pack': 3,
    'bondfires.camp_slots.10pack': 10,
  }
  if (packMap[storeProductId]) {
    return packMap[storeProductId]
  }
  // Legacy pattern: bondfires.extra_camp.N
  const legacyMatch = storeProductId.match(/\.(\d+)$/)
  if (legacyMatch) {
    const qty = Number.parseInt(legacyMatch[1], 10)
    if (qty > 0) return qty
  }
  // Fallback
  return 1
}

async function findExistingConsumablePurchase(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeTransactionId?: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeTransactionId) {
    const storeTransactionId = args.storeTransactionId
    const byTransactions = await ctx.db
      .query('consumablePurchases')
      .withIndex('by_transaction', (q) => q.eq('storeTransactionId', storeTransactionId))
      .collect()
    const byTransaction = selectStoreRecordForUser(byTransactions, args.userId)
    if (byTransaction) return byTransaction
  }

  if (args.storeOriginalTransactionId) {
    const storeOriginalTransactionId = args.storeOriginalTransactionId
    const byOriginalTransactions = await ctx.db
      .query('consumablePurchases')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', storeOriginalTransactionId),
      )
      .collect()
    const byOriginalTransaction = selectStoreRecordForUser(byOriginalTransactions, args.userId)
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const storePurchaseToken = args.storePurchaseToken
    const byPurchaseTokens = await ctx.db
      .query('consumablePurchases')
      .withIndex('by_store_purchase_token', (q) => q.eq('storePurchaseToken', storePurchaseToken))
      .collect()
    const byPurchaseToken = selectStoreRecordForUser(byPurchaseTokens, args.userId)
    if (byPurchaseToken) return byPurchaseToken
  }

  const unverifiedPurchases = await ctx.db
    .query('consumablePurchases')
    .withIndex('by_user', (q) => q.eq('userId', args.userId))
    .collect()

  return (
    unverifiedPurchases
      .filter(
        (purchase) =>
          purchase.storeProductId === args.storeProductId &&
          (purchase.verificationStatus === 'pending' || purchase.verificationStatus === 'failed'),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  )
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    const now = Date.now()
    const subscriptions = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const activeSubscriptions = subscriptions.filter(
      (subscription) =>
        subscription.verificationStatus === 'verified' &&
        (subscription.status === 'active' || subscription.status === 'trialing') &&
        (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now),
    )
    const subscription =
      activeSubscriptions.sort((left, right) => TIER_RANK[right.tier] - TIER_RANK[left.tier])[0] ??
      null
    const pendingStorePurchaseCount =
      subscriptions.filter(
        (subscription) =>
          subscription.status === 'pending_verification' &&
          subscription.verificationStatus === 'pending',
      ).length +
      (
        await ctx.db
          .query('consumablePurchases')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect()
      ).filter((purchase) => purchase.verificationStatus === 'pending').length

    // Compute kindling balance from ledger
    const kindlingTransactions = await ctx.db
      .query('campSlotTransactions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const kindlingBalance = kindlingTransactions.reduce((sum, tx) => sum + tx.amount, 0)

    return {
      tier,
      subscription,
      canCreateBondfires: tierCanCreateBondfires(tier),
      maxVideoDurationMs: getTierMaxVideoDurationMs(tier),
      kindlingBalance,
      pendingStorePurchaseCount,
    }
  },
})

export const canCreatePrivateCamp = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return false
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    return tier === 'plus' || tier === 'premium' || tier === 'pro'
  },
})

export const syncStorePurchase = mutation({
  args: {
    platform: v.union(v.literal('ios'), v.literal('android')),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    purchasedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tier: SubscriptionTier; kind: StorePurchaseKind; status: StoreSyncStatus }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const kind = getStorePurchaseKind(args.storeProductId)
    if (!kind) {
      throw new Error(`Unsupported store product: ${args.storeProductId}`)
    }

    assertStoreIdentifiers(args)

    if (await wasRetainedForDeletedAccount(ctx, args)) {
      throw new Error('This store purchase belonged to a deleted account and cannot be reused')
    }

    const now = Date.now()
    let syncStatus: StoreSyncStatus = 'pending_verification'
    const pendingStoreFields = {
      userId,
      status: 'pending_verification' as const,
      verificationStatus: 'pending' as const,
      platform: args.platform,
      storeProductId: args.storeProductId,
      currentPeriodEnd: args.currentPeriodEnd,
      updatedAt: now,
    }

    if (kind === 'subscription') {
      const tier = PRODUCT_ID_TO_TIER[args.storeProductId]
      if (!tier) {
        throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
      }

      const existing = await findExistingSubscription(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeOriginalTransactionId: getStoreOriginalTransactionId(args),
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store subscription is already linked to another account')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          // Do not mutate verified identifiers or tier from client input. The
          // following action may still verify a legitimate store upgrade.
        } else {
          await ctx.db.patch(existing._id, {
            ...pendingStoreFields,
            tier,
          })
        }
      } else {
        await ctx.db.insert('subscriptions', {
          ...pendingStoreFields,
          tier,
          createdAt: args.purchasedAt ?? now,
        })
      }
    } else {
      // Consumable purchase (kindling pack)
      const existing = await findExistingConsumablePurchase(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: getStoreOriginalTransactionId(args),
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store purchase is already linked to another account')
      }
      if (isRefundedStoreRecord(existing)) {
        throw new Error('This store purchase has already been refunded')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          // A verified consumable is immutable; replay/product mismatch is
          // decided from the authoritative store response in the action.
        } else {
          await ctx.db.patch(existing._id, {
            userId,
            verificationStatus: 'pending' as const,
            platform: args.platform,
            storeProductId: args.storeProductId,
            updatedAt: now,
            quantity: getKindlingQuantityForProduct(args.storeProductId),
          })
        }
      } else {
        await ctx.db.insert('consumablePurchases', {
          userId,
          verificationStatus: 'pending' as const,
          platform: args.platform,
          storeProductId: args.storeProductId,
          updatedAt: now,
          quantity: getKindlingQuantityForProduct(args.storeProductId),
          createdAt: args.purchasedAt ?? now,
        })
      }
    }

    return {
      tier: await getEntitlementSubscriptionTier(ctx, userId),
      kind,
      status: syncStatus,
    }
  },
})

export const applyStorePurchaseVerification = internalMutation({
  args: {
    userId: v.id('users'),
    kind: storePurchaseKindValidator,
    platform: v.union(v.literal('ios'), v.literal('android')),
    requestedStoreProductId: v.string(),
    lookupStoreTransactionId: v.optional(v.string()),
    lookupStoreOriginalTransactionId: v.optional(v.string()),
    lookupStorePurchaseToken: v.optional(v.string()),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    status: storeStatusValidator,
    storeState: v.optional(storeLifecycleValidator),
    willRenew: v.optional(v.boolean()),
    storeEnvironment: v.optional(v.string()),
    lastStoreEventAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ tier: SubscriptionTier; status: StoreSyncStatus }> => {
    assertStoreProductMatchesKind(args.storeProductId, args.kind)

    const user = await ctx.db.get(args.userId)
    if (!user || user.accountDeletionStatus) {
      return { tier: 'free', status: 'expired' }
    }
    // Check the provider's identifiers atomically with the write. An action
    // may have started before deletion completed or used different lookup IDs.
    if (await wasRetainedForDeletedAccount(ctx, args)) {
      throw new Error('This store purchase belonged to a deleted account and cannot be reused')
    }

    const now = Date.now()
    let appliedStatus: StoreSyncStatus = args.status
    const storeState = args.storeState ?? lifecycleStateForStatus(args.status)
    const verificationStatus =
      args.kind === 'consumable'
        ? args.status === 'active'
          ? ('verified' as const)
          : args.status === 'pending_verification'
            ? ('pending' as const)
            : ('refunded' as const)
        : storeState === 'refunded' || storeState === 'revoked'
          ? ('refunded' as const)
          : getVerificationStateForStatus(args.status)
    const lookup = {
      userId: args.userId,
      storeProductId: args.requestedStoreProductId,
      storeOriginalTransactionId:
        args.lookupStoreOriginalTransactionId ??
        args.lookupStoreTransactionId ??
        args.lookupStorePurchaseToken,
      storePurchaseToken: args.lookupStorePurchaseToken,
    }

    if (args.kind === 'subscription') {
      const previousEffectiveTier = await getActiveSubscriptionTier(ctx, args.userId)
      const tier = getTierForStoreProduct(args.storeProductId)
      if (!tier) {
        throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
      }

      const existing =
        (await findExistingSubscription(ctx, {
          userId: args.userId,
          storeProductId: args.storeProductId,
          storeOriginalTransactionId: args.storeOriginalTransactionId,
          storePurchaseToken: args.storePurchaseToken,
          includePendingFallback: false,
        })) ?? (await findExistingSubscription(ctx, lookup))

      if (existing && existing.userId !== args.userId) {
        throw new Error('This store subscription is already linked to another account')
      }

      const fields = {
        userId: args.userId,
        tier,
        status: args.status,
        verificationStatus,
        platform: args.platform,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
        currentPeriodEnd: args.currentPeriodEnd,
        storeState,
        willRenew: args.willRenew,
        storeEnvironment: args.storeEnvironment,
        lastStoreEventAt:
          args.lastStoreEventAt === undefined
            ? existing?.lastStoreEventAt
            : Math.max(existing?.lastStoreEventAt ?? 0, args.lastStoreEventAt),
        lastStoreSyncAt: now,
        nextStoreSyncAt: nextStoreSyncAt(now, storeState),
        storeSyncFailureCount: 0,
        lastStoreSyncErrorCode: undefined,
        verifiedAt: verificationStatus === 'pending' ? undefined : now,
        updatedAt: now,
      }

      if (existing) {
        await ctx.db.patch(existing._id, fields)
      } else {
        await ctx.db.insert('subscriptions', {
          ...fields,
          createdAt: now,
        })
      }

      if (verificationStatus === 'verified' || verificationStatus === 'refunded') {
        const newEffectiveTier = await getActiveSubscriptionTier(ctx, args.userId)

        // Grant the 3 free monthly kindling first so that reclaim/upgrade
        // logic has kindling available to consume for public camps.
        if (TIER_RANK[newEffectiveTier] >= TIER_RANK.pro) {
          await ctx.runMutation(internal.campKindling.grantMonthlyKindling, { userId: args.userId })
        }

        if (TIER_RANK[newEffectiveTier] < TIER_RANK[previousEffectiveTier]) {
          await handleTierDowngrade(ctx, args.userId, previousEffectiveTier, newEffectiveTier)
        } else if (TIER_RANK[newEffectiveTier] > TIER_RANK[previousEffectiveTier]) {
          await handleTierUpgrade(ctx, args.userId, previousEffectiveTier, newEffectiveTier)
          if (TIER_RANK[newEffectiveTier] >= TIER_RANK.pro) {
            await reclaimFrozenCamps(ctx, args.userId, newEffectiveTier)
          }
        }

        // Personal camp lifecycle: freeze on downgrade to Free, ensure exists on paid upgrade.
        if (newEffectiveTier === 'free' && previousEffectiveTier !== 'free') {
          await ctx.runMutation(internal.personalCamps.freezePersonalCamp, {
            ownerId: args.userId,
          })
        } else if (newEffectiveTier !== 'free') {
          // Ensure hearth exists on paid tier
          await ctx.runMutation(internal.personalCamps.internalGetOrCreatePersonalCamp, {
            userId: args.userId,
            tier: newEffectiveTier,
          })
        }
      }
    } else {
      // Consumable purchase verification (kindling pack)
      const consumableLookup = {
        userId: args.userId,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      }
      const existing =
        (await findExistingConsumablePurchase(ctx, consumableLookup)) ??
        (await findExistingConsumablePurchase(ctx, {
          userId: args.userId,
          storeProductId: args.requestedStoreProductId,
          storeTransactionId: args.lookupStoreTransactionId,
          storeOriginalTransactionId:
            args.lookupStoreOriginalTransactionId ??
            args.lookupStoreTransactionId ??
            args.lookupStorePurchaseToken,
          storePurchaseToken: args.lookupStorePurchaseToken,
        }))

      if (existing && existing.userId !== args.userId) {
        throw new Error('This store purchase is already linked to another account')
      }
      if (isRefundedStoreRecord(existing)) {
        throw new Error('This store purchase has already been refunded')
      }

      const quantity = getKindlingQuantityForProduct(args.storeProductId)
      const fields = {
        userId: args.userId,
        platform: args.platform as 'ios' | 'android',
        storeProductId: args.storeProductId,
        storeTransactionId:
          args.storeTransactionId ?? args.storeOriginalTransactionId ?? args.storePurchaseToken,
        storeOriginalTransactionId:
          args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken,
        storePurchaseToken: args.storePurchaseToken,
        quantity,
        verificationStatus,
        verifiedAt: verificationStatus === 'verified' ? now : undefined,
        updatedAt: now,
      }
      const alreadyVerified = existing?.verificationStatus === 'verified'
      let consumablePurchaseId: Id<'consumablePurchases'>

      if (existing) {
        await ctx.db.patch(existing._id, fields)
        consumablePurchaseId = existing._id
      } else {
        consumablePurchaseId = await ctx.db.insert('consumablePurchases', {
          ...fields,
          createdAt: now,
        })
      }

      appliedStatus = args.status

      // On verified consumable purchase, credit kindling balance via internal mutation.
      if (
        !alreadyVerified &&
        verificationStatus === 'verified' &&
        statusUnlocksEntitlements(args.status)
      ) {
        await ctx.runMutation(internal.campKindling.creditKindlingPurchase, {
          userId: args.userId,
          kindlingCount: quantity,
          metadata: {
            consumablePurchaseId,
            storeProductId: args.storeProductId,
            storeTransactionId: args.storeTransactionId,
            storeOriginalTransactionId: args.storeOriginalTransactionId,
            storePurchaseToken: args.storePurchaseToken,
            platform: args.platform,
          },
        })
      }
    }

    return {
      tier: await getEntitlementSubscriptionTier(ctx, args.userId),
      status: appliedStatus,
    }
  },
})

export const markStorePurchaseVerificationFailed = internalMutation({
  args: {
    userId: v.id('users'),
    kind: storePurchaseKindValidator,
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lookup = {
      userId: args.userId,
      storeProductId: args.storeProductId,
      storeOriginalTransactionId:
        args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken,
      storePurchaseToken: args.storePurchaseToken,
    }
    const consumableLookup = {
      userId: args.userId,
      storeProductId: args.storeProductId,
      storeTransactionId: args.storeTransactionId,
      storeOriginalTransactionId:
        args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken,
      storePurchaseToken: args.storePurchaseToken,
    }
    const existing =
      args.kind === 'subscription'
        ? await findExistingSubscription(ctx, lookup)
        : await findExistingConsumablePurchase(ctx, consumableLookup)

    if (
      !existing ||
      existing.userId !== args.userId ||
      isVerifiedActiveStoreRecord(existing) ||
      isRefundedStoreRecord(existing)
    ) {
      return
    }

    await ctx.db.patch(existing._id, {
      verificationStatus: 'failed',
      updatedAt: Date.now(),
    })
  },
})

export const verifyStorePurchase = action({
  args: {
    platform: v.union(v.literal('ios'), v.literal('android')),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tier: SubscriptionTier; kind: StorePurchaseKind; status: StoreSyncStatus }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const kind = getStorePurchaseKind(args.storeProductId)
    if (!kind) {
      throw new Error(`Unsupported store product: ${args.storeProductId}`)
    }

    assertStoreIdentifiers(args)

    try {
      const verification =
        args.platform === 'ios'
          ? await ctx.runAction(internal.storeBillingActions.verifyApplePurchase, {
              kind,
              storeProductId: args.storeProductId,
              storeTransactionId: args.storeTransactionId,
              storeOriginalTransactionId: args.storeOriginalTransactionId,
            })
          : await ctx.runAction(internal.storeBillingActions.verifyGooglePurchase, {
              kind,
              storeProductId: args.storeProductId,
              storePurchaseToken: args.storePurchaseToken ?? '',
            })

      assertStoreProductMatchesKind(verification.storeProductId, kind)
      // Legacy ownership must refer to the purchase the provider actually
      // verified, never a client-selected record belonging to this user.
      const ownership = await ctx.runQuery(internal.storeBilling.getVerificationContext, {
        userId,
        kind,
        storeOriginalTransactionId: verification.storeOriginalTransactionId,
        storePurchaseToken: verification.storePurchaseToken,
      })
      assertStoreAccountOwnership({
        ...ownership,
        verifiedAccountToken: verification.verifiedAccountToken,
      })

      const result = await ctx.runMutation(internal.subscriptions.applyStorePurchaseVerification, {
        userId,
        kind,
        platform: args.platform,
        requestedStoreProductId: args.storeProductId,
        lookupStoreTransactionId: args.storeTransactionId,
        lookupStoreOriginalTransactionId: args.storeOriginalTransactionId,
        lookupStorePurchaseToken: args.storePurchaseToken,
        storeProductId: verification.storeProductId,
        storeTransactionId: verification.storeTransactionId,
        storeOriginalTransactionId: verification.storeOriginalTransactionId,
        storePurchaseToken: verification.storePurchaseToken,
        currentPeriodEnd: verification.currentPeriodEnd,
        status: verification.status,
        storeState: verification.storeState,
        willRenew: verification.willRenew,
        storeEnvironment: verification.storeEnvironment,
      })

      return {
        tier: result.tier,
        kind,
        status: result.status,
      }
    } catch (error) {
      await ctx.runMutation(internal.subscriptions.markStorePurchaseVerificationFailed, {
        userId,
        kind,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      throw error
    }
  },
})

export const processExpiredReclaims = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await processExpiredReclaimsImpl(ctx)
    // biome-ignore lint/suspicious/noConsole: cron job diagnostic logging
    console.log(
      `Reclaim processed: ${result.campsTransferred} transferred, ${result.campsArchived} archived`,
    )
    return result
  },
})
