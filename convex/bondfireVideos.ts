import { v } from 'convex/values'
import { internal } from './_generated/api'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// Get all videos for a bondfire
export const listByBondfire = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
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
    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()

    return videos.filter((video) => video.expiresAt === undefined || video.expiresAt > Date.now())
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
    const bondfire = await ctx.db.get(args.bondfireId)

    if (!bondfire) {
      throw new Error('Bondfire not found')
    }

    const now = Date.now()

    if (!args.muxAssetId || !args.muxPlaybackId) {
      throw new Error('Mux asset ID and playback ID are required for Mux videos')
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

    // Update the bondfire's video count
    await ctx.db.patch(args.bondfireId, {
      videoCount: bondfire.videoCount + 1,
      updatedAt: now,
    })

    // Update user's response count
    await ctx.db.patch(userId, {
      responseCount: (user?.responseCount ?? 0) + 1,
      updatedAt: now,
    })

    // Send push notification to bondfire creator
    await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
      bondfireId: args.bondfireId,
      responderId: userId,
      responderName: user?.displayName ?? user?.name ?? 'Someone',
    })

    return videoId
  },
})
