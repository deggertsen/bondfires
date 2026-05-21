import { query } from './_generated/server'
import { auth } from './auth'
import {
  getActiveSubscriptionTier,
  getTierMaxVideoDurationMs,
  TIER_RANK,
  tierCanCreateBondfires,
} from './entitlements'

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const user = await ctx.db.get(userId)
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
      canCreateBondfires: user?.isReviewerAccount === true || tierCanCreateBondfires(tier),
      maxVideoDurationMs:
        user?.isReviewerAccount === true ? undefined : getTierMaxVideoDurationMs(tier),
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

    // Check if user is a reviewer account
    const user = await ctx.db.get(userId)
    if (user?.isReviewerAccount) {
      return true
    }

    const tier = await getActiveSubscriptionTier(ctx, userId)
    return tier === 'plus' || tier === 'premium' || tier === 'pro'
  },
})
