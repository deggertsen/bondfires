import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { enforceWatchEventLimit } from './abuseLimits'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
} from './bondfireVisibility'
import { isModeratedContentVisible } from './contentSafety'

type WatchVideoType = 'bondfire' | 'response'
type WatchEventType = 'start' | 'milestone_25' | 'milestone_50' | 'milestone_75' | 'complete'

const MAX_WATCH_POSITION_MS = 6 * 60 * 60 * 1_000
const MAX_WATCH_HISTORY_LIMIT = 100
const WATCH_EVENT_RATIOS: Partial<Record<WatchEventType, number>> = {
  milestone_25: 0.2,
  milestone_50: 0.45,
  milestone_75: 0.7,
  complete: 0.85,
}

export function normalizeWatchHistoryLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return 50
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_WATCH_HISTORY_LIMIT)
}

export function validateWatchEventState(args: {
  eventType: WatchEventType
  positionMs: number
  serverDurationMs?: number
  hasStart: boolean
  alreadyRecorded: boolean
}):
  | 'duplicate'
  | 'invalid_position'
  | 'start_required'
  | 'duration_unavailable'
  | 'position_too_early'
  | null {
  if (args.alreadyRecorded) return 'duplicate'
  if (
    !Number.isInteger(args.positionMs) ||
    args.positionMs < 0 ||
    args.positionMs > MAX_WATCH_POSITION_MS
  ) {
    return 'invalid_position'
  }
  if (args.eventType === 'start') return args.positionMs <= 5_000 ? null : 'invalid_position'
  if (!args.hasStart) return 'start_required'

  const ratio = WATCH_EVENT_RATIOS[args.eventType]
  if (
    ratio !== undefined &&
    (args.serverDurationMs === undefined ||
      !Number.isFinite(args.serverDurationMs) ||
      args.serverDurationMs <= 0)
  ) {
    return 'duration_unavailable'
  }
  if (
    ratio !== undefined &&
    args.serverDurationMs !== undefined &&
    args.positionMs < args.serverDurationMs * ratio
  ) {
    return 'position_too_early'
  }
  if (
    args.serverDurationMs !== undefined &&
    args.serverDurationMs > 0 &&
    args.positionMs > args.serverDurationMs + 30_000
  ) {
    return 'invalid_position'
  }
  return null
}

function isPlayable(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
}) {
  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

export async function resolveVisibleWatchTarget(
  ctx: MutationCtx,
  args: { videoType: WatchVideoType; videoId: string },
  viewerId: Id<'users'>,
) {
  const viewer = await buildViewerVisibilityContext(ctx, viewerId)
  if (args.videoType === 'bondfire') {
    const id = ctx.db.normalizeId('bondfires', args.videoId)
    if (!id) return null
    const bondfire = await ctx.db.get(id)
    if (!bondfire || !isPlayable(bondfire)) return null
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) return null
    return { durationMs: bondfire.durationMs }
  }

  const id = ctx.db.normalizeId('bondfireVideos', args.videoId)
  if (!id) return null
  const response = await ctx.db.get(id)
  if (!response || !isPlayable(response)) return null
  if (!(await isUserContentVisibleToViewer(ctx, response.userId, viewer))) return null
  if (
    !isModeratedContentVisible(response.moderationStatus, {
      isOwner: viewerId === response.userId,
      isAdmin: viewer.isAdmin,
    })
  )
    return null
  if (response.expiresAt !== undefined && response.expiresAt <= Date.now()) return null
  const bondfire = await ctx.db.get(response.bondfireId)
  if (!bondfire || !(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) return null
  return { durationMs: response.durationMs }
}

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

    await enforceWatchEventLimit(ctx, userId)
    const target = await resolveVisibleWatchTarget(ctx, args, userId)
    if (!target) return { recorded: false, reason: 'unavailable' as const }

    const [existing, start] = await Promise.all([
      ctx.db
        .query('watchEvents')
        .withIndex('by_user_video_event', (q) =>
          q.eq('userId', userId).eq('videoId', args.videoId).eq('eventType', args.eventType),
        )
        .first(),
      args.eventType === 'start'
        ? Promise.resolve(null)
        : ctx.db
            .query('watchEvents')
            .withIndex('by_user_video_event', (q) =>
              q.eq('userId', userId).eq('videoId', args.videoId).eq('eventType', 'start'),
            )
            .first(),
    ])
    const stateError = validateWatchEventState({
      eventType: args.eventType,
      positionMs: args.positionMs,
      serverDurationMs: target.durationMs,
      hasStart: start !== null,
      alreadyRecorded: existing !== null,
    })
    if (stateError) return { recorded: false, reason: stateError }

    const profileViewResult =
      args.eventType === 'start'
        ? await incrementProfileViews(ctx, args, userId)
        : ({ counted: false, reason: 'not_start' } as const)

    await ctx.db.insert('watchEvents', {
      userId,
      videoType: args.videoType,
      videoId: args.videoId,
      eventType: args.eventType,
      positionMs: args.positionMs,
      // Duration is authoritative media metadata. The optional client field is
      // retained in the API only for compatibility with deployed builds.
      durationMs: target.durationMs,
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

    const event = await ctx.db
      .query('watchEvents')
      .withIndex('by_user_video_event', (q) => {
        const target = q.eq('userId', userId).eq('videoId', args.videoId)
        return args.eventType ? target.eq('eventType', args.eventType) : target
      })
      .first()
    return event !== null
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

    const limit = normalizeWatchHistoryLimit(args.limit)

    return await ctx.db
      .query('watchEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit)
  },
})
