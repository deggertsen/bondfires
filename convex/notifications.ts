import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'
import { logServerEvent } from './serverTelemetry'

// Register a device token for push notifications.
//
// This mutation is background infrastructure called from mount, foreground,
// and sign-in flows. It must NOT throw when the Convex auth session hasn't
// resolved yet — the client-side `isAuthenticated` ref can be true while the
// server-side session is still establishing, and throwing a ConvexError here
// causes the Convex client library to log `console.error` before the user's
// catch block runs, which telemetry captures as a `console:error` event.
// Instead, return `null` so the client treats it as a no-op and retries on
// the next lifecycle event.
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
      // Auth session hasn't resolved yet. Return null instead of throwing so
      // the Convex client library doesn't log a console.error (which telemetry
      // captures as a `console:error` event and storms the error dashboard).
      // The client retries on the next lifecycle event (foreground, sign-in).
      return null
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
      await logServerEvent(ctx, {
        level: 'breadcrumb',
        event: 'push:registerDevice:updated',
        message: 'Updated existing push device token',
        userId,
        data: {
          tokenId: existing._id,
          platform: args.platform,
          tokenType: args.tokenType ?? 'expo',
          deviceId: args.deviceId,
        },
      })
      return existing._id
    }

    // Create new token entry
    const tokenId = await ctx.db.insert('deviceTokens', {
      userId,
      token: args.token,
      platform: args.platform,
      tokenType: args.tokenType ?? 'expo',
      deviceId: args.deviceId,
      timezone: args.timezone,
      createdAt: now,
      updatedAt: now,
    })
    await logServerEvent(ctx, {
      level: 'breadcrumb',
      event: 'push:registerDevice:created',
      message: 'Registered new push device token',
      userId,
      data: {
        tokenId,
        platform: args.platform,
        tokenType: args.tokenType ?? 'expo',
        deviceId: args.deviceId,
      },
    })
    return tokenId
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

/** Diagnostic: count of device tokens for the current user (for push debugging). */
export const getDeviceTokenCount = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    count: number
    tokens: {
      platform: string
      tokenType: string | undefined
      deviceId: string | undefined
      createdAt: number
      updatedAt: number
    }[]
  }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { count: 0, tokens: [] }
    }

    const tokens = await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    return {
      count: tokens.length,
      tokens: tokens.map((t) => ({
        platform: t.platform,
        tokenType: t.tokenType,
        deviceId: t.deviceId,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    }
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
  responses: boolean
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
        responses?: boolean
        reminders?: boolean
        invitesAndMembership?: boolean
        hearth?: boolean
        digestWindowHour?: number
      }
    | undefined,
): NotificationPreferences {
  const recordingActivity = prefs?.recordingActivity ?? true

  return {
    recordingActivity,
    // `responses` used to be folded into `recordingActivity`. Preserve an
    // existing opt-out until the user explicitly sets the new split toggle.
    responses: prefs?.responses ?? prefs?.recordingActivity ?? true,
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
    responses: v.optional(v.boolean()),
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
        ...(args.responses !== undefined ? { responses: args.responses } : {}),
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
