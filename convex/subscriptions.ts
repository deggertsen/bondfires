import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'

type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  pro: 3,
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
