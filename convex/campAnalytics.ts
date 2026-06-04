import { v } from 'convex/values'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

async function getCurrentUser(ctx: QueryCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  return user
}

export const getCampAnalytics = query({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    // Only the owner can query analytics
    if (camp.ownerId !== user._id) {
      throwUserError('Only the camp owner can view analytics')
    }

    // Active members = count of campMembers where status is 'active' and not banned
    const activeMembers = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', args.campId).eq('status', 'active'))
      .collect()

    // Total bondfires = count of bondfires where campId matches, not deleted/frozen
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .filter((q) => q.neq(q.field('frozen'), true))
      .collect()

    // Total responses = count of bondfireVideos where bondfire's campId matches
    // (responses to bondfires in this camp)
    const bondfireIds = new Set(bondfires.map((b) => b._id))
    let totalResponses = 0

    for (const bondfireId of bondfireIds) {
      const videos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      totalResponses += videos.length
    }

    return {
      activeMembers: activeMembers.length,
      totalBondfires: bondfires.length,
      totalResponses,
    }
  },
})
