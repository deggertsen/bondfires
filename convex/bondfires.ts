import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// List bondfires for the feed (ordered by videoCount ASC for discovery)
export const listFeed = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20

    // Query bondfires ordered by video_count ascending (prioritize newer/smaller)
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_video_count')
      .order('asc')
      .take(limit * 3)

    return bondfires
      .filter((bondfire) => (bondfire.videoStatus ?? 'ready') === 'ready' && bondfire.muxPlaybackId)
      .slice(0, limit)
  },
})

// Get a single bondfire by ID
export const get = query({
  args: { id: v.id('bondfires') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id)
  },
})

// Get a bondfire with all its response videos
export const getWithVideos = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || (bondfire.videoStatus ?? 'ready') !== 'ready' || !bondfire.muxPlaybackId) {
      return null
    }

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    const readyVideos = videos.filter(
      (video) => (video.videoStatus ?? 'ready') === 'ready' && video.muxPlaybackId,
    )

    return {
      ...bondfire,
      videos: readyVideos,
    }
  },
})

// Get bondfires by user
export const listByUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()

    return bondfires.filter(
      (bondfire) => (bondfire.videoStatus ?? 'ready') === 'ready' && bondfire.muxPlaybackId,
    )
  },
})

// Create a new bondfire
export const create = mutation({
  args: {
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
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
    const now = Date.now()

    if (!args.muxAssetId || !args.muxPlaybackId) {
      throw new Error('Mux asset ID and playback ID are required for Mux videos')
    }

    const bondfireId = await ctx.db.insert('bondfires', {
      userId,
      creatorName: user?.displayName ?? user?.name,
      videoStatus: args.videoStatus ?? 'ready',
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy,
      muxAssetStatus: args.videoStatus,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1, // Starts with 1 (the original video)
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    // Update user's bondfire count
    await ctx.db.patch(userId, {
      bondfireCount: (user?.bondfireCount ?? 0) + 1,
      updatedAt: now,
    })

    return bondfireId
  },
})

// Increment view count
export const incrementViews = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      throw new Error('Bondfire not found')
    }

    await ctx.db.patch(args.bondfireId, {
      viewCount: (bondfire.viewCount ?? 0) + 1,
      updatedAt: Date.now(),
    })
  },
})
