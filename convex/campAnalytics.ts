import { v } from 'convex/values'
import { query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

/**
 * Per-camp analytics: active members, total bondfires, total responses.
 * Only the camp owner can access this data.
 */
export const getCampAnalytics = query({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    if (camp.ownerId !== userId) {
      throwUserError('Only the camp owner can view analytics')
    }

    // Active members
    const members = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', args.campId).eq('status', 'active'))
      .collect()

    // Total bondfires in this camp (not frozen)
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .filter((q) => q.neq(q.field('frozen'), true))
      .collect()

    // Total responses = sum of (videoCount - 1) for each bondfire
    let totalResponses = 0
    for (const b of bondfires) {
      totalResponses += Math.max(0, (b.videoCount ?? 1) - 1)
    }

    return {
      activeMembers: members.length,
      totalBondfires: bondfires.length,
      totalResponses,
    }
  },
})
