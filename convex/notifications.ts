import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// Register a device token for push notifications
export const registerDevice = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
    experienceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const now = Date.now()

    // Check if token already exists
    const existing = await ctx.db
      .query('deviceTokens')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first()

    if (existing) {
      // Update the existing token
      await ctx.db.patch(existing._id, {
        userId,
        platform: args.platform,
        experienceId: args.experienceId,
        updatedAt: now,
      })
      return existing._id
    }

    // Create new token entry
    return await ctx.db.insert('deviceTokens', {
      userId,
      token: args.token,
      platform: args.platform,
      experienceId: args.experienceId,
      createdAt: now,
      updatedAt: now,
    })
  },
})

// Unregister a device token
export const unregisterDevice = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const existing = await ctx.db
      .query('deviceTokens')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first()

    if (existing && existing.userId === userId) {
      await ctx.db.delete(existing._id)
    }
  },
})

// Get user's registered devices
export const getDevices = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    return await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
  },
})

// Get all device tokens for a user (internal use for sending notifications)
export const getTokensForUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect()
  },
})

