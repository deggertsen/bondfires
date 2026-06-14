import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

// Register a device token for push notifications
export const registerDevice = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
    tokenType: v.optional(v.union(v.literal('fcm'), v.literal('expo'))),
    deviceId: v.optional(v.string()),
    // IANA timezone (e.g. 'America/Denver') for local-time digest delivery
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      // Background token registration races the auth session on sign-in. Throw a
      // ConvexError (not a raw Error, which Convex masks as a 500 "Server Error"
      // and storms the client retry/telemetry path) so the client's retryable
      // "Not authenticated" filter matches and silently waits for the session.
      throwUserError('Not authenticated')
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
        tokenType: args.tokenType ?? 'expo',
        deviceId: args.deviceId,
        timezone: args.timezone ?? existing.timezone,
        updatedAt: now,
      })
      return existing._id
    }

    // Create new token entry
    return await ctx.db.insert('deviceTokens', {
      userId,
      token: args.token,
      platform: args.platform,
      tokenType: args.tokenType ?? 'fcm',
      deviceId: args.deviceId,
      timezone: args.timezone,
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
      throwUserError('Not authenticated')
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

// ── Per-category notification preferences ──
// Enforced server-side in sendNotification.sendToUser. Missing keys mean
// enabled; account-critical notifications (camp lifecycle) always send.

export interface NotificationPreferences {
  recordingActivity: boolean
  reminders: boolean
  invitesAndMembership: boolean
  hearth: boolean
  digestWindowHour: number
}

export const DEFAULT_DIGEST_WINDOW_HOUR = 17

export function resolveNotificationPrefs(
  prefs:
    | {
        recordingActivity?: boolean
        reminders?: boolean
        invitesAndMembership?: boolean
        hearth?: boolean
        digestWindowHour?: number
      }
    | undefined,
): NotificationPreferences {
  return {
    recordingActivity: prefs?.recordingActivity ?? true,
    reminders: prefs?.reminders ?? true,
    invitesAndMembership: prefs?.invitesAndMembership ?? true,
    hearth: prefs?.hearth ?? true,
    digestWindowHour: prefs?.digestWindowHour ?? DEFAULT_DIGEST_WINDOW_HOUR,
  }
}

/** Current user's notification preferences (defaults filled in). */
export const getPreferences = query({
  args: {},
  handler: async (ctx): Promise<NotificationPreferences | null> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }
    const user = await ctx.db.get(userId)
    return resolveNotificationPrefs(user?.notificationPrefs)
  },
})

/** Update the current user's notification preferences (partial). */
export const updatePreferences = mutation({
  args: {
    recordingActivity: v.optional(v.boolean()),
    reminders: v.optional(v.boolean()),
    invitesAndMembership: v.optional(v.boolean()),
    hearth: v.optional(v.boolean()),
    digestWindowHour: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    if (
      args.digestWindowHour !== undefined &&
      (!Number.isInteger(args.digestWindowHour) ||
        args.digestWindowHour < 0 ||
        args.digestWindowHour > 23)
    ) {
      throw new Error('digestWindowHour must be an integer between 0 and 23')
    }

    const user = await ctx.db.get(userId)
    const existing = user?.notificationPrefs ?? {}

    await ctx.db.patch(userId, {
      notificationPrefs: {
        ...existing,
        ...(args.recordingActivity !== undefined
          ? { recordingActivity: args.recordingActivity }
          : {}),
        ...(args.reminders !== undefined ? { reminders: args.reminders } : {}),
        ...(args.invitesAndMembership !== undefined
          ? { invitesAndMembership: args.invitesAndMembership }
          : {}),
        ...(args.hearth !== undefined ? { hearth: args.hearth } : {}),
        ...(args.digestWindowHour !== undefined ? { digestWindowHour: args.digestWindowHour } : {}),
      },
    })

    return { success: true }
  },
})
