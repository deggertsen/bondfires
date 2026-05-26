import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

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

function parseBirthDate(birthDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day }
}

function calculateAge(birthDate: string): number | undefined {
  const birth = parseBirthDate(birthDate)
  if (!birth) {
    return undefined
  }

  const today = new Date()
  let age = today.getFullYear() - birth.year
  const monthDelta = today.getMonth() + 1 - birth.month
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.day)) {
    age -= 1
  }
  return age
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
    age: user.birthDate ? calculateAge(user.birthDate) : undefined,
    bondfireCount: user.bondfireCount ?? 0,
    responseCount: user.responseCount ?? 0,
    totalViews: user.totalViews ?? 0,
    isAdmin: user.isAdmin,
    role: user.role,
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

export const backfillMissingGender = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1000
    const users = await ctx.db.query('users').take(limit)
    let updated = 0

    for (const user of users) {
      if (user.gender) {
        continue
      }

      await ctx.db.patch(user._id, {
        gender: 'male',
        updatedAt: Date.now(),
      })
      updated += 1
    }

    return {
      updated,
      scanned: users.length,
      remainingMayExist: users.length === limit,
    }
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

// Delete user account and all associated data
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const user = await ctx.db.get(userId)
    if (user?.photoStorageId) {
      await ctx.storage.delete(user.photoStorageId)
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

    const threadReads = await ctx.db
      .query('bondfireThreadReads')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const read of threadReads) {
      await ctx.db.delete(read._id)
    }

    const ownedPins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .collect()

    for (const pin of ownedPins) {
      await ctx.db.delete(pin._id)
    }

    const incomingPins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_pinned_user', (q) => q.eq('pinnedUserId', userId))
      .collect()

    for (const pin of incomingPins) {
      await ctx.db.delete(pin._id)
    }

    // 4. Delete all user's device tokens
    const deviceTokens = await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const token of deviceTokens) {
      await ctx.db.delete(token._id)
    }

    // 5. Delete camp memberships, invites, and subscriptions
    const campMemberships = await ctx.db
      .query('campMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const membership of campMemberships) {
      await ctx.db.delete(membership._id)
    }

    const campInvites = await ctx.db
      .query('campInvites')
      .withIndex('by_created_by', (q) => q.eq('createdBy', userId))
      .collect()

    for (const invite of campInvites) {
      await ctx.db.delete(invite._id)
    }

    const subscriptions = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const subscription of subscriptions) {
      await ctx.db.delete(subscription._id)
    }

    // 6. Delete auth-related data (sessions, accounts, refresh tokens)
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

    // 7. Finally, delete the user record itself
    await ctx.db.delete(userId)

    return { success: true }
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
