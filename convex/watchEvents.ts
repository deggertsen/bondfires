import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// Record a watch event
export const record = mutation({
  args: {
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
    videoId: v.string(),
    eventType: v.union(
      v.literal('start'),
      v.literal('milestone_25'),
      v.literal('milestone_50'),
      v.literal('milestone_75'),
      v.literal('complete'),
    ),
    positionMs: v.number(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    await ctx.db.insert('watchEvents', {
      userId,
      videoType: args.videoType,
      videoId: args.videoId,
      eventType: args.eventType,
      positionMs: args.positionMs,
      durationMs: args.durationMs,
      createdAt: Date.now(),
    })
  },
})

// Check if user has watched a video (for tracking completion)
export const hasWatched = query({
  args: {
    videoId: v.string(),
    eventType: v.optional(
      v.union(
        v.literal('start'),
        v.literal('milestone_25'),
        v.literal('milestone_50'),
        v.literal('milestone_75'),
        v.literal('complete'),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return false
    }

    const events = await ctx.db
      .query('watchEvents')
      .withIndex('by_user_video', (q) => q.eq('userId', userId).eq('videoId', args.videoId))
      .collect()

    if (args.eventType) {
      return events.some((e) => e.eventType === args.eventType)
    }

    return events.length > 0
  },
})

// Get watch history for current user
export const getHistory = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const limit = args.limit ?? 50

    return await ctx.db
      .query('watchEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit)
  },
})
