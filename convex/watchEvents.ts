import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { buildViewerVisibilityContext, isBondfireVisibleToViewer } from './bondfireVisibility'

type WatchVideoType = 'bondfire' | 'response'
type WatchEventType = 'start' | 'milestone_25' | 'milestone_50' | 'milestone_75' | 'complete'

export function getProfileViewCountChanges({
  videoType,
  ownerId,
  viewerId,
  eventType,
  ownerTotalViews,
  bondfireViewCount,
}: {
  videoType: WatchVideoType
  ownerId: Id<'users'>
  viewerId: Id<'users'>
  eventType: WatchEventType
  ownerTotalViews: number | undefined
  bondfireViewCount?: number | undefined
}) {
  if (eventType !== 'start' || ownerId === viewerId) return null

  return {
    ownerTotalViews: (ownerTotalViews ?? 0) + 1,
    ...(videoType === 'bondfire' ? { bondfireViewCount: (bondfireViewCount ?? 0) + 1 } : {}),
  }
}

type ProfileViewResult =
  | { counted: true }
  | {
      counted: false
      reason: 'not_start' | 'video_not_found' | 'not_visible' | 'own_video' | 'creator_not_found'
    }

export async function incrementProfileViews(
  ctx: MutationCtx,
  args: { videoType: WatchVideoType; videoId: string; eventType: WatchEventType },
  viewerId: Id<'users'>,
): Promise<ProfileViewResult> {
  if (args.eventType !== 'start') return { counted: false, reason: 'not_start' }

  if (args.videoType === 'response') {
    const responseId = ctx.db.normalizeId('bondfireVideos', args.videoId)
    if (!responseId) return { counted: false, reason: 'video_not_found' }

    const response = await ctx.db.get(responseId)
    if (!response || (response.expiresAt !== undefined && response.expiresAt <= Date.now())) {
      return { counted: false, reason: 'video_not_found' }
    }

    const bondfire = await ctx.db.get(response.bondfireId)
    if (!bondfire) return { counted: false, reason: 'video_not_found' }

    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
      return { counted: false, reason: 'not_visible' }
    }

    const owner = await ctx.db.get(response.userId)
    if (!owner) return { counted: false, reason: 'creator_not_found' }

    const changes = getProfileViewCountChanges({
      videoType: args.videoType,
      ownerId: response.userId,
      viewerId,
      eventType: args.eventType,
      ownerTotalViews: owner.totalViews,
    })
    if (!changes) return { counted: false, reason: 'own_video' }

    await ctx.db.patch(response.userId, {
      totalViews: changes.ownerTotalViews,
      updatedAt: Date.now(),
    })
    return { counted: true }
  }

  const bondfireId = ctx.db.normalizeId('bondfires', args.videoId)
  if (!bondfireId) return { counted: false, reason: 'video_not_found' }

  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire) return { counted: false, reason: 'video_not_found' }

  const viewer = await buildViewerVisibilityContext(ctx, viewerId)
  if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
    return { counted: false, reason: 'not_visible' }
  }

  const owner = await ctx.db.get(bondfire.userId)
  if (!owner) return { counted: false, reason: 'creator_not_found' }

  const changes = getProfileViewCountChanges({
    videoType: args.videoType,
    ownerId: bondfire.userId,
    viewerId,
    eventType: args.eventType,
    ownerTotalViews: owner.totalViews,
    bondfireViewCount: bondfire.viewCount,
  })
  if (!changes) return { counted: false, reason: 'own_video' }

  const now = Date.now()
  await ctx.db.patch(bondfire.userId, {
    totalViews: changes.ownerTotalViews,
    updatedAt: now,
  })
  await ctx.db.patch(bondfireId, {
    viewCount: changes.bondfireViewCount,
    updatedAt: now,
  })
  return { counted: true }
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

    const profileViewResult = await incrementProfileViews(ctx, args, userId)
    if (
      args.eventType === 'start' &&
      !profileViewResult.counted &&
      (profileViewResult.reason === 'video_not_found' || profileViewResult.reason === 'not_visible')
    ) {
      return { recorded: false, reason: profileViewResult.reason }
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

    return { recorded: true, profileViewCounted: profileViewResult.counted }
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
