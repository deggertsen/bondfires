import { v } from 'convex/values'
import { internal } from './_generated/api'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// Get all videos for a bondfire
export const listByBondfire = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()
  },
})

// Get response videos by user
export const listByUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()
  },
})

// Add a response video to a bondfire
export const addResponse = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    storageProvider: v.optional(v.union(v.literal('s3'), v.literal('bunny'))),
    videoKey: v.optional(v.string()),
    sdVideoKey: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    bunnyVideoId: v.optional(v.string()),
    bunnyLibraryId: v.optional(v.string()),
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
    const storageProvider = args.storageProvider ?? (args.bunnyVideoId ? 'bunny' : 's3')

    if (storageProvider === 'bunny' && (!args.bunnyVideoId || !args.bunnyLibraryId)) {
      throw new Error('Bunny video ID and library ID are required for Bunny Stream videos')
    }

    if (storageProvider === 's3' && !args.videoKey) {
      throw new Error('S3 video key is required for S3 videos')
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
      storageProvider,
      videoKey: args.videoKey,
      sdVideoKey: args.sdVideoKey,
      thumbnailKey: args.thumbnailKey,
      bunnyVideoId: args.bunnyVideoId,
      bunnyLibraryId: args.bunnyLibraryId,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
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
