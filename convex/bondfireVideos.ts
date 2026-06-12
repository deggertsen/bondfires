import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { buildViewerVisibilityContext, isBondfireVisibleToViewer } from './bondfireVisibility'
import { isCampParticipableStatus } from './campLifecycle'
import { assertVideoDurationWithinTierLimit } from './entitlements'
import { assertCanRespondToPersonalBondfire } from './personalBondfireAccess'
import { countResponse } from './responseCounts'

async function assertCanRespondToBondfire(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    bondfireId: Id<'bondfires'>
    durationMs?: number
  },
): Promise<Doc<'bondfires'>> {
  const [user, bondfire] = await Promise.all([ctx.db.get(args.userId), ctx.db.get(args.bondfireId)])
  if (!user) {
    throw new Error('User not found')
  }
  if (!bondfire) {
    throw new Error('Bondfire not found')
  }
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    throw new Error('Bondfire not found')
  }

  await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)

  if (bondfire.personalCampId) {
    await assertCanRespondToPersonalBondfire(ctx, {
      bondfire,
      userId: args.userId,
    })
    return bondfire
  }

  if (!bondfire.campId) {
    return bondfire
  }

  const camp = await ctx.db.get(bondfire.campId)
  if (!camp || !isCampParticipableStatus(camp.status)) {
    throw new Error('Camp not found')
  }

  const membership = await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', args.userId).eq('campId', camp._id))
    .first()
  if (membership?.status !== 'active') {
    throw new Error('Join this camp before responding here')
  }

  const campGender = camp.rules?.access.gender?.value
  if (campGender && campGender !== 'any' && user.gender !== campGender) {
    throw new Error('This camp is limited to members who match its gender setting')
  }

  if (
    camp.rules?.participation.maxDurationMs &&
    args.durationMs &&
    args.durationMs > camp.rules.participation.maxDurationMs
  ) {
    throw new Error('This recording is longer than the camp allows')
  }

  if (camp.rules?.participation.maxResponses !== undefined) {
    const existingVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    const activeResponses = existingVideos.filter((video) => video.videoStatus !== 'errored')
    if (activeResponses.length >= camp.rules.participation.maxResponses) {
      throw new Error('This Bondfire already has the maximum number of responses')
    }
  }

  return bondfire
}

// Get all videos for a bondfire
export const listByBondfire = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      return []
    }

    const userId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, userId)
    const canViewBondfire = await isBondfireVisibleToViewer(ctx, bondfire, viewer)
    if (!canViewBondfire) {
      return []
    }

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    return videos.filter((video) => {
      if (video.expiresAt !== undefined && video.expiresAt <= Date.now()) {
        return false
      }

      const status = video.videoStatus ?? 'ready'
      return (
        (status === 'ready' && video.muxPlaybackId) ||
        (status === 'live' && video.muxLivePlaybackId)
      )
    })
  },
})

// Get response videos by user
export const listByUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const viewerId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()

    const visibleVideos = []
    for (const video of videos) {
      if (video.expiresAt !== undefined && video.expiresAt <= Date.now()) {
        continue
      }

      const bondfire = await ctx.db.get(video.bondfireId)
      if (bondfire && (await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
        visibleVideos.push(video)
      }
    }

    return visibleVideos
  },
})

// Add a response video to a bondfire
export const addResponse = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
        v.literal('live'),
        v.literal('ready'),
        v.literal('errored'),
      ),
    ),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const user = await ctx.db.get(userId)
    const bondfire = await assertCanRespondToBondfire(ctx, {
      userId,
      bondfireId: args.bondfireId,
      durationMs: args.durationMs,
    })

    const now = Date.now()

    if (!args.muxAssetId || !args.muxPlaybackId) {
      throw new Error('Mux asset ID and playback ID are required for Mux videos')
    }

    let requiresSignedPlayback = bondfire.muxPlaybackPolicy === 'signed'
    if (!requiresSignedPlayback && bondfire.personalCampId) {
      requiresSignedPlayback = true
    }
    if (!requiresSignedPlayback && bondfire.campId) {
      const camp = await ctx.db.get(bondfire.campId)
      requiresSignedPlayback = camp?.access === 'invite'
    }
    if (requiresSignedPlayback && args.muxPlaybackPolicy !== 'signed') {
      throw new Error('Private camp response videos must use signed Mux playback')
    }

    // Get the next sequence number
    const existingVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()

    const sequenceNumber = existingVideos.length + 1 // +1 because original is sequence 0

    // Create the response video
    const videoId = await ctx.db.insert('bondfireVideos', {
      bondfireId: args.bondfireId,
      userId,
      creatorName: user?.displayName ?? user?.name,
      sequenceNumber,
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy,
      muxAssetStatus: args.videoStatus,
      videoStatus: args.videoStatus ?? 'ready',
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      expiresAt: bondfire.expiresAt,
      createdAt: now,
    })

    // Count the response (videoCount + responseCount) through the shared
    // helper so every counter mutation stays idempotent via countedAt.
    const insertedVideo = await ctx.db.get(videoId)
    if (insertedVideo) {
      await countResponse(ctx, insertedVideo)
    }

    // Send push notification to thread participants (deduped + throttled)
    await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
      bondfireId: args.bondfireId,
      responderId: userId,
      responderName: user?.displayName ?? user?.name ?? 'Someone',
      bondfireVideoId: videoId,
    })

    return videoId
  },
})
