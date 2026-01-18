import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

// Get the current authenticated user
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }
    return await ctx.db.get(userId)
  },
})

// Get a user by ID
export const get = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId)
  },
})

// Update user profile
export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const updates: Record<string, unknown> = {
      updatedAt: Date.now(),
    }

    if (args.name !== undefined) updates.name = args.name
    if (args.displayName !== undefined) updates.displayName = args.displayName
    if (args.photoUrl !== undefined) updates.photoUrl = args.photoUrl

    await ctx.db.patch(userId, updates)
    return await ctx.db.get(userId)
  },
})

// Get user stats
export const getStats = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (!user) {
      return null
    }

    return {
      bondfireCount: user.bondfireCount ?? 0,
      responseCount: user.responseCount ?? 0,
      totalViews: user.totalViews ?? 0,
    }
  },
})

// Delete user account and all associated data
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    // 1. Delete all user's response videos (bondfireVideos)
    const userVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const video of userVideos) {
      // Decrement the parent bondfire's video count
      const bondfire = await ctx.db.get(video.bondfireId)
      if (bondfire) {
        await ctx.db.patch(video.bondfireId, {
          videoCount: Math.max(0, bondfire.videoCount - 1),
          updatedAt: Date.now(),
        })
      }
      await ctx.db.delete(video._id)
    }

    // 2. Delete all user's bondfires (and their response videos)
    const userBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const bondfire of userBondfires) {
      // Delete all response videos for this bondfire
      const bondfireResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of bondfireResponses) {
        await ctx.db.delete(response._id)
      }

      await ctx.db.delete(bondfire._id)
    }

    // 3. Delete all user's watch events
    const watchEvents = await ctx.db
      .query('watchEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const event of watchEvents) {
      await ctx.db.delete(event._id)
    }

    // 4. Delete all user's device tokens
    const deviceTokens = await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const token of deviceTokens) {
      await ctx.db.delete(token._id)
    }

    // 5. Delete auth-related data (sessions, accounts, refresh tokens)
    // These tables are created by @convex-dev/auth
    const authSessions = await ctx.db
      .query('authSessions')
      .withIndex('userId', (q) => q.eq('userId', userId))
      .collect()

    for (const session of authSessions) {
      // Delete associated refresh tokens
      const refreshTokens = await ctx.db
        .query('authRefreshTokens')
        .withIndex('sessionId', (q) => q.eq('sessionId', session._id))
        .collect()

      for (const token of refreshTokens) {
        await ctx.db.delete(token._id)
      }

      await ctx.db.delete(session._id)
    }

    // Delete auth accounts linked to this user
    const authAccounts = await ctx.db
      .query('authAccounts')
      .withIndex('userIdAndProvider', (q) => q.eq('userId', userId))
      .collect()

    for (const account of authAccounts) {
      await ctx.db.delete(account._id)
    }

    // 6. Finally, delete the user record itself
    await ctx.db.delete(userId)

    return { success: true }
  },
})
