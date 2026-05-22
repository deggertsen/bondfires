import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'
type SubscriptionPlatform = 'ios' | 'android'

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  pro: 3,
}

const PRODUCT_ID_TO_TIER: Record<string, SubscriptionTier | undefined> = {
  'bondfires.plus.monthly': 'plus',
  'bondfires.plus.annual': 'plus',
  'bondfires.premium.monthly': 'premium',
  'bondfires.premium.annual': 'premium',
  'bondfires.pro.monthly': 'pro',
  'bondfires.pro.annual': 'pro',
}

async function getActiveSubscriptionTier(ctx: QueryCtx, userId: Id<'users'>) {
  const now = Date.now()
  const subscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  const activeSubscriptions = subscriptions.filter(
    (subscription) =>
      (subscription.status === 'active' || subscription.status === 'trialing') &&
      (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now),
  )

  return activeSubscriptions.reduce<SubscriptionTier>(
    (highest, subscription) =>
      TIER_RANK[subscription.tier] > TIER_RANK[highest] ? subscription.tier : highest,
    'free',
  )
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

  const activeSubscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'active'))
    .collect()

  return (
    activeSubscriptions.find(
      (subscription) => subscription.storeProductId === args.storeProductId,
    ) ?? null
  )
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const tier = await getActiveSubscriptionTier(ctx, userId)
    const now = Date.now()
    const subscriptions = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const activeSubscriptions = subscriptions.filter(
      (subscription) =>
        (subscription.status === 'active' || subscription.status === 'trialing') &&
        (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now),
    )
    const subscription =
      activeSubscriptions.sort((left, right) => TIER_RANK[right.tier] - TIER_RANK[left.tier])[0] ??
      null

    return {
      tier,
      subscription,
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

    const tier = await getActiveSubscriptionTier(ctx, userId)
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
  handler: async (ctx, args): Promise<{ tier: SubscriptionTier }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const tier = PRODUCT_ID_TO_TIER[args.storeProductId]
    if (!tier) {
      throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
    }

    const now = Date.now()
    const storeOriginalTransactionId =
      args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken
    const existing = await findExistingSubscription(ctx, {
      userId,
      storeProductId: args.storeProductId,
      storeOriginalTransactionId,
      storePurchaseToken: args.storePurchaseToken,
    })
    if (existing && existing.userId !== userId) {
      throw new Error('This store subscription is already linked to another account')
    }

    const subscription = {
      userId,
      tier,
      status: 'active' as const,
      platform: args.platform as SubscriptionPlatform,
      storeProductId: args.storeProductId,
      storeTransactionId: args.storeTransactionId,
      storeOriginalTransactionId,
      storePurchaseToken: args.storePurchaseToken,
      currentPeriodEnd: args.currentPeriodEnd,
      updatedAt: now,
    }

    if (existing) {
      await ctx.db.patch(existing._id, subscription)
    } else {
      await ctx.db.insert('subscriptions', {
        ...subscription,
        createdAt: args.purchasedAt ?? now,
      })
    }

    return { tier }
  },
})
