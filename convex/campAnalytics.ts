import { v } from 'convex/values'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

async function getCurrentUserId(ctx: QueryCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  return userId
}

export const getCampAnalytics = query({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx)

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    if (camp.ownerId !== userId) {
      throwUserError('Only the camp owner can view analytics')
    }

    const activeMembers = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', args.campId).eq('status', 'active'))
      .collect()

    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .filter((q) => q.neq(q.field('frozen'), true))
      .collect()

    const totalResponses = bondfires.reduce(
      (total, bondfire) => total + Math.max(0, bondfire.videoCount - 1),
      0,
    )

    return {
      activeMembers: activeMembers.length,
      totalBondfires: bondfires.length,
      totalResponses,
    }
  },
})
