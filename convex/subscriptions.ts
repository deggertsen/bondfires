import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  getActiveProExtraPublicCampAddOnCount,
  getEntitlementSubscriptionTier,
  getPublicCampLimit,
  getTierMaxVideoDurationMs,
  type SubscriptionTier,
  TIER_RANK,
  tierCanCreateBondfires,
} from './entitlements'

type SubscriptionPlatform = 'ios' | 'android'
type StorePurchaseKind = 'subscription' | 'proExtraCamp'
type StoreSyncStatus = 'pending_verification' | 'active' | 'trialing'

const PRODUCT_ID_TO_TIER: Record<string, SubscriptionTier | undefined> = {
  'bondfires.plus.monthly': 'plus',
  'bondfires.plus.annual': 'plus',
  'bondfires.premium.monthly': 'premium',
  'bondfires.premium.annual': 'premium',
  'bondfires.pro.monthly': 'pro',
  'bondfires.pro.annual': 'pro',
}

const PRO_EXTRA_CAMP_PRODUCT_IDS = new Set([
  'bondfires.pro.extra_camp.monthly',
  'bondfires.pro.extra_camp.annual',
])

function getStorePurchaseKind(storeProductId: string): StorePurchaseKind | null {
  if (PRODUCT_ID_TO_TIER[storeProductId]) {
    return 'subscription'
  }

  if (PRO_EXTRA_CAMP_PRODUCT_IDS.has(storeProductId)) {
    return 'proExtraCamp'
  }

  return null
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
  if (args.platform === 'android' && !args.storePurchaseToken) {
    throw new Error('Android purchases require a store purchase token')
  }

  if (args.platform === 'ios' && !args.storeOriginalTransactionId && !args.storeTransactionId) {
    throw new Error('iOS purchases require a store transaction identifier')
  }
}

function getVerifiedSyncStatus(existing?: {
  status: string
  verificationStatus?: string
}): StoreSyncStatus {
  if (
    existing?.verificationStatus === 'verified' &&
    (existing.status === 'active' || existing.status === 'trialing')
  ) {
    return existing.status
  }

  return 'pending_verification'
}

function isVerifiedActiveStoreRecord(existing?: { status: string; verificationStatus?: string }) {
  return getVerifiedSyncStatus(existing) !== 'pending_verification'
}

async function findExistingSubscription(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeOriginalTransactionId) {
    const byOriginalTransaction = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .first()
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const byPurchaseToken = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_purchase_token', (q) =>
        q.eq('storePurchaseToken', args.storePurchaseToken),
      )
      .first()
    if (byPurchaseToken) return byPurchaseToken
  }

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

async function findExistingAddOn(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeOriginalTransactionId) {
    const byOriginalTransaction = await ctx.db
      .query('subscriptionAddOns')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .first()
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const byPurchaseToken = await ctx.db
      .query('subscriptionAddOns')
      .withIndex('by_store_purchase_token', (q) =>
        q.eq('storePurchaseToken', args.storePurchaseToken),
      )
      .first()
    if (byPurchaseToken) return byPurchaseToken
  }

  const pendingAddOns = await ctx.db
    .query('subscriptionAddOns')
    .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'pending_verification'))
    .collect()

  return pendingAddOns.find((addOn) => addOn.storeProductId === args.storeProductId) ?? null
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const user = await ctx.db.get(userId)
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
      subscriptions.filter((subscription) => subscription.status === 'pending_verification')
        .length +
      (
        await ctx.db
          .query('subscriptionAddOns')
          .withIndex('by_user', (q) => q.eq('userId', userId).eq('status', 'pending_verification'))
          .collect()
      ).length

    return {
      tier,
      subscription,
      canCreateBondfires: user?.isReviewerAccount === true || tierCanCreateBondfires(tier),
      maxVideoDurationMs:
        user?.isReviewerAccount === true ? undefined : getTierMaxVideoDurationMs(tier),
      proExtraPublicCampAddOns: await getActiveProExtraPublicCampAddOnCount(ctx, userId),
      publicCampLimit:
        user?.isReviewerAccount === true ? undefined : await getPublicCampLimit(ctx, userId),
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

    const user = await ctx.db.get(userId)
    if (user?.isReviewerAccount) {
      return true
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

    const now = Date.now()
    const storeOriginalTransactionId = getStoreOriginalTransactionId(args)
    let syncStatus: StoreSyncStatus = 'pending_verification'
    const receiptFields = {
      storeTransactionId: args.storeTransactionId,
      storeOriginalTransactionId,
      storePurchaseToken: args.storePurchaseToken,
      updatedAt: now,
    }
    const pendingStoreFields = {
      userId,
      status: 'pending_verification' as const,
      verificationStatus: 'pending' as const,
      platform: args.platform,
      storeProductId: args.storeProductId,
      ...receiptFields,
      currentPeriodEnd: args.currentPeriodEnd,
    }

    if (kind === 'subscription') {
      const tier = PRODUCT_ID_TO_TIER[args.storeProductId]
      if (!tier) {
        throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
      }

      const existing = await findExistingSubscription(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store subscription is already linked to another account')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          if (existing.storeProductId !== args.storeProductId) {
            throw new Error('Store subscription product changes require server verification')
          }
          await ctx.db.patch(existing._id, receiptFields)
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
      const existing = await findExistingAddOn(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store add-on is already linked to another account')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          if (existing.storeProductId !== args.storeProductId) {
            throw new Error('Store add-on product changes require server verification')
          }
          await ctx.db.patch(existing._id, receiptFields)
        } else {
          await ctx.db.patch(existing._id, {
            ...pendingStoreFields,
            type: 'pro_extra_public_camp',
          })
        }
      } else {
        await ctx.db.insert('subscriptionAddOns', {
          ...pendingStoreFields,
          type: 'pro_extra_public_camp',
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
