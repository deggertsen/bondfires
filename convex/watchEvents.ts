import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

type WatchVideoType = 'bondfire' | 'response'
type WatchEventType = 'start' | 'milestone_25' | 'milestone_50' | 'milestone_75' | 'complete'

export function shouldCountProfileView({
  eventType,
  ownerId,
  viewerId,
}: {
  videoType: WatchVideoType
  eventType: WatchEventType
  ownerId: Id<'users'>
  viewerId: Id<'users'>
}) {
  return eventType === 'start' && ownerId !== viewerId
}

export async function incrementProfileViews(
  ctx: MutationCtx,
  args: { videoType: WatchVideoType; videoId: string; eventType: WatchEventType },
  viewerId: Id<'users'>,
) {
  if (args.eventType !== 'start') return false

  if (args.videoType === 'response') {
    const responseId = ctx.db.normalizeId('bondfireVideos', args.videoId)
    if (!responseId) return false

    const response = await ctx.db.get(responseId)
    if (
      !response ||
      !shouldCountProfileView({
        videoType: args.videoType,
        eventType: args.eventType,
        ownerId: response.userId,
        viewerId,
      })
    ) {
      return false
    }

    const owner = await ctx.db.get(response.userId)
    if (!owner) return false

    await ctx.db.patch(response.userId, {
      totalViews: (owner.totalViews ?? 0) + 1,
      updatedAt: Date.now(),
    })
    return true
  }

  const bondfireId = ctx.db.normalizeId('bondfires', args.videoId)
  if (!bondfireId) return false

  const bondfire = await ctx.db.get(bondfireId)
  if (
    !bondfire ||
    !shouldCountProfileView({
      videoType: args.videoType,
      eventType: args.eventType,
      ownerId: bondfire.userId,
      viewerId,
    })
  ) {
    return false
  }

  const owner = await ctx.db.get(bondfire.userId)
  if (!owner) return false

  const now = Date.now()
  await ctx.db.patch(bondfire.userId, {
    totalViews: (owner.totalViews ?? 0) + 1,
    updatedAt: now,
  })
  await ctx.db.patch(bondfireId, {
    viewCount: (bondfire.viewCount ?? 0) + 1,
    updatedAt: now,
  })
  return true
}

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

    await incrementProfileViews(ctx, args, userId)

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
