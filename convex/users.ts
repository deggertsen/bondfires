import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { calculateAgeAt } from './agePolicy'
import { auth } from './auth'
import { throwUserError } from './errors'

/**
 * App-open heartbeat. The client calls this on launch/foreground
 * (throttled client-side). Powers the 72h nudge kill switch in
 * convex/digest.ts — a user who opened the app recently never gets a
 * re-engagement nudge. No-op when unauthenticated.
 */
export const recordActive = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return
    }
    await ctx.db.patch(userId, { lastActiveAt: Date.now() })
  },
})

function publicUser(user: Doc<'users'>) {
  return {
    _id: user._id,
    name: user.name,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    bondfireCount: user.bondfireCount ?? 0,
    responseCount: user.responseCount ?? 0,
    totalViews: user.totalViews ?? 0,
  }
}

function currentUser(user: Doc<'users'>) {
  return {
    _id: user._id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    gender: user.gender,
    age: user.birthDate ? (calculateAgeAt(user.birthDate) ?? undefined) : undefined,
    bondfireCount: user.bondfireCount ?? 0,
    responseCount: user.responseCount ?? 0,
    totalViews: user.totalViews ?? 0,
    pinnedBondfireIds: user.pinnedBondfireIds ?? [],
    isAdmin: user.isAdmin,
    role: user.role,
    themePreference: user.themePreference ?? 'system',
  }
}

// Get the current authenticated user
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }
    const user = await ctx.db.get(userId)
    return user ? currentUser(user) : null
  },
})

// Get a user by ID
export const get = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    return user ? publicUser(user) : null
  },
})

// Update user profile
export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    gender: v.optional(v.union(v.literal('male'), v.literal('female'), v.literal('other'))),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const updates: Record<string, unknown> = {
      updatedAt: Date.now(),
    }

    if (args.name !== undefined) updates.name = args.name
    if (args.firstName !== undefined) updates.firstName = args.firstName
    if (args.lastName !== undefined) updates.lastName = args.lastName
    if (args.displayName !== undefined) updates.displayName = args.displayName
    if (args.gender !== undefined) updates.gender = args.gender

    await ctx.db.patch(userId, updates)
    const user = await ctx.db.get(userId)
    return user ? currentUser(user) : null
  },
})

export const setThemePreference = mutation({
  args: {
    themePreference: v.union(v.literal('system'), v.literal('light'), v.literal('dark')),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }
    await ctx.db.patch(userId, {
      themePreference: args.themePreference,
      updatedAt: Date.now(),
    })
    const user = await ctx.db.get(userId)
    return user ? currentUser(user) : null
  },
})

export const generateProfilePhotoUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    return await ctx.storage.generateUploadUrl()
  },
})

export const updateProfilePhoto = mutation({
  args: {
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const user = await ctx.db.get(userId)
    const photoUrl = await ctx.storage.getUrl(args.storageId)
    if (!photoUrl) {
      throwUserError('Uploaded photo not found')
    }

    await ctx.db.patch(userId, {
      photoStorageId: args.storageId,
      photoUrl,
      updatedAt: Date.now(),
    })

    if (user?.photoStorageId && user.photoStorageId !== args.storageId) {
      await ctx.storage.delete(user.photoStorageId)
    }

    const updatedUser = await ctx.db.get(userId)
    return updatedUser ? currentUser(updatedUser) : null
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

// Check if the current user is an admin
export const isAdmin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) return false

    const user = await ctx.db.get(userId)
    return user?.role === 'admin' || user?.isAdmin === true
  },
})
