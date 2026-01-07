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

