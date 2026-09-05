/**
 * Client-side telemetry logging.
 *
 * Accepts breadcrumbs, errors, and warnings from the React Native app
 * and persists them for debugging and support purposes.
 */

import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  reserveClientLogRateLimit,
  validateClientLogBatch,
  validateClientLogEntry,
} from './lib/clientTelemetry'

const LOG_LEVELS = ['error', 'warn', 'info', 'breadcrumb'] as const
const PURGEABLE_RETENTIONS = [undefined, 'standard'] as const
const MAX_RETENTION_DAYS = 30
const MAX_LIST_LIMIT = 100

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentUserId(ctx: QueryCtx | MutationCtx): Promise<Id<'users'> | undefined> {
  try {
    const userId = await auth.getUserId(ctx)
    return userId ?? undefined
  } catch {
    return undefined
  }
}

async function requireCurrentUserId(ctx: MutationCtx): Promise<Id<'users'>> {
  const userId = await getCurrentUserId(ctx)
  if (!userId) throw new Error('Not authenticated')
  return userId
}

async function reserveIngestionCapacity(
  ctx: MutationCtx,
  userId: Id<'users'>,
  requestedEntries: number,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query('clientLogRateLimits')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique()

  let next: ReturnType<typeof reserveClientLogRateLimit>
  try {
    next = reserveClientLogRateLimit(existing, now, requestedEntries)
  } catch (error) {
    throw new ConvexError({
      code: 'TELEMETRY_RATE_LIMITED',
      message: error instanceof Error ? error.message : 'Telemetry rate limit exceeded',
    })
  }
  if (existing) {
    await ctx.db.patch(existing._id, next)
  } else {
    await ctx.db.insert('clientLogRateLimits', { userId, ...next })
  }
}

function validateClientEntryOrThrow(
  entry: Parameters<typeof validateClientLogEntry>[0],
  now: number,
) {
  try {
    validateClientLogEntry(entry, now)
  } catch (error) {
    throw new ConvexError({
      code: 'INVALID_TELEMETRY',
      message: error instanceof Error ? error.message : 'Invalid telemetry entry',
    })
  }
}

function validateClientBatchOrThrow(
  entry: Parameters<typeof validateClientLogBatch>[0],
  now: number,
) {
  try {
    validateClientLogBatch(entry, now)
  } catch (error) {
    throw new ConvexError({
      code: 'INVALID_TELEMETRY',
      message: error instanceof Error ? error.message : 'Invalid telemetry batch',
    })
  }
}

function logEntry(doc: Doc<'clientLogs'>) {
  return {
    _id: doc._id,
    userId: doc.userId,
    level: doc.level,
    event: doc.event,
    message: doc.message,
    data: doc.data,
    platform: doc.platform,
    appVersion: doc.appVersion,
    sessionId: doc.sessionId,
    retention: doc.retention,
    createdAt: doc.createdAt,
    device: doc.device,
  }
}

// ---------------------------------------------------------------------------
// Public mutations
// ---------------------------------------------------------------------------

/**
 * Insert a single authenticated client log entry. Identity is always derived
 * from the current session; clients cannot select which user owns a log.
 *
 * `userId` remains in the validator temporarily because released clients send
 * it. The handler deliberately ignores it so backend-first deploys remain
 * compatible without trusting client-selected ownership.
 */
const DEVICE_INFO = v.optional(
  v.object({
    modelName: v.optional(v.string()),
    osVersion: v.optional(v.string()),
    osName: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    brand: v.optional(v.string()),
  }),
)

export const create = mutation({
  args: {
    level: v.union(
      v.literal('error'),
      v.literal('warn'),
      v.literal('info'),
      v.literal('breadcrumb'),
    ),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    platform: v.union(v.literal('ios'), v.literal('android')),
    appVersion: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    createdAt: v.number(),
    userId: v.optional(v.id('users')),
    device: DEVICE_INFO,
  },
  handler: async (ctx, args) => {
    const userId = await requireCurrentUserId(ctx)
    const now = Date.now()
    validateClientEntryOrThrow(args, now)
    await reserveIngestionCapacity(ctx, userId, 1, now)

    return await ctx.db.insert('clientLogs', {
      userId,
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      platform: args.platform,
      appVersion: args.appVersion,
      sessionId: args.sessionId,
      retention: 'standard',
      createdAt: args.createdAt,
      device: args.device,
    })
  },
})

/**
 * Batch-insert authenticated log entries. A non-empty bounded batch is
 * validated atomically before any rows or rate-limit state are written. The
 * legacy `userId` field is accepted for installed-client compatibility and
 * ignored; every inserted row uses the authenticated session identity.
 */
export const createBatch = mutation({
  args: {
    entries: v.array(
      v.object({
        level: v.union(
          v.literal('error'),
          v.literal('warn'),
          v.literal('info'),
          v.literal('breadcrumb'),
        ),
        event: v.string(),
        message: v.string(),
        data: v.optional(v.any()),
        platform: v.union(v.literal('ios'), v.literal('android')),
        appVersion: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        createdAt: v.number(),
        userId: v.optional(v.id('users')),
        device: DEVICE_INFO,
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireCurrentUserId(ctx)
    const now = Date.now()
    validateClientBatchOrThrow(args.entries, now)
    await reserveIngestionCapacity(ctx, userId, args.entries.length, now)
    const ids: Id<'clientLogs'>[] = []

    for (const entry of args.entries) {
      const id = await ctx.db.insert('clientLogs', {
        userId,
        level: entry.level,
        event: entry.event,
        message: entry.message,
        data: entry.data,
        platform: entry.platform,
        appVersion: entry.appVersion,
        sessionId: entry.sessionId,
        retention: 'standard',
        createdAt: entry.createdAt,
        device: entry.device,
      })
      ids.push(id)
    }

    return ids
  },
})

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * Paginated list of client logs, filterable by userId, level, event prefix,
 * and time range.  Requires admin access.
 */
export const list = query({
  args: {
    userId: v.optional(v.id('users')),
    level: v.optional(
      v.union(v.literal('error'), v.literal('warn'), v.literal('info'), v.literal('breadcrumb')),
    ),
    eventPrefix: v.optional(v.string()),
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Admin check
    const currentUserId = await getCurrentUserId(ctx)
    if (!currentUserId) throw new Error('Not authenticated')

    const currentUser = await ctx.db.get(currentUserId)
    if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
      throw new Error('Admin access required')
    }

    const pageSize = Math.min(args.limit ?? 50, MAX_LIST_LIMIT)
    const { startTime, endTime } = args

    // Pick the most selective index
    if (args.userId) {
      const userId = args.userId
      let query = ctx.db
        .query('clientLogs')
        .withIndex('by_log_user', (q) => q.eq('userId', userId))
        .order('desc')

      if (startTime !== undefined) {
        query = query.filter((q) => q.gte(q.field('createdAt'), startTime))
      }
      if (endTime !== undefined) {
        query = query.filter((q) => q.lte(q.field('createdAt'), endTime))
      }

      const results = await query.take(pageSize)

      return { entries: results.map(logEntry), cursor: null }
    }

    if (args.level) {
      const level = args.level
      let query = ctx.db
        .query('clientLogs')
        .withIndex('by_log_level', (q) => q.eq('level', level))
        .order('desc')

      if (startTime !== undefined) {
        query = query.filter((q) => q.gte(q.field('createdAt'), startTime))
      }
      if (endTime !== undefined) {
        query = query.filter((q) => q.lte(q.field('createdAt'), endTime))
      }

      const results = await query.take(pageSize)

      return { entries: results.map(logEntry), cursor: null }
    }

    // Fallback: query by event index
    const prefix = args.eventPrefix ?? ''
    let query = ctx.db
      .query('clientLogs')
      .withIndex('by_log_event', (q) => {
        if (prefix) {
          return q.gte('event', prefix).lt('event', `${prefix}\uffff`)
        }
        return q
      })
      .order('desc')

    if (startTime !== undefined) {
      query = query.filter((q) => q.gte(q.field('createdAt'), startTime))
    }
    if (endTime !== undefined) {
      query = query.filter((q) => q.lte(q.field('createdAt'), endTime))
    }

    const results = await query.take(pageSize)

    return { entries: results.map(logEntry), cursor: null }
  },
})

/**
 * Aggregate counts grouped by level for the last 24 hours.
 * Requires admin access.
 */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const currentUserId = await getCurrentUserId(ctx)
    if (!currentUserId) throw new Error('Not authenticated')

    const currentUser = await ctx.db.get(currentUserId)
    if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
      throw new Error('Admin access required')
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const counts: Record<string, number> = {}

    for (const level of LOG_LEVELS) {
      const entries = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_level', (q) => q.eq('level', level))
        .filter((q) => q.gte(q.field('createdAt'), cutoff))
        .take(1000)

      counts[level] = entries.length
    }

    return { cutoff, counts }
  },
})

// ---------------------------------------------------------------------------
// Internal (cron-accessible) mutations
// ---------------------------------------------------------------------------

/**
 * Server-side log entry (callable from internal actions/mutations).
 */
export const createInternal = internalMutation({
  args: {
    level: v.union(
      v.literal('error'),
      v.literal('warn'),
      v.literal('info'),
      v.literal('breadcrumb'),
    ),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    platform: v.union(v.literal('ios'), v.literal('android'), v.literal('server')),
    createdAt: v.number(),
    userId: v.optional(v.id('users')),
    device: DEVICE_INFO,
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('clientLogs', {
      userId: args.userId,
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      platform: args.platform,
      appVersion: undefined,
      sessionId: undefined,
      retention: 'standard',
      createdAt: args.createdAt,
      device: args.device,
    })
  },
})

/**
 * TEMPORARY triage query — remove after investigating the camera-freeze
 * regression. Pulls recent rows by session, event prefix, or level.
 */
export const _debugTriage = internalQuery({
  args: {
    sessionId: v.optional(v.string()),
    eventPrefix: v.optional(v.string()),
    level: v.optional(
      v.union(v.literal('error'), v.literal('warn'), v.literal('info'), v.literal('breadcrumb')),
    ),
    sinceMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 100, 500)
    const since = args.sinceMs ?? Date.now() - 6 * 60 * 60 * 1000

    let rows: Doc<'clientLogs'>[]
    if (args.sessionId) {
      const sessionId = args.sessionId
      rows = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_session', (q) => q.eq('sessionId', sessionId))
        .order('desc')
        .take(limit)
    } else if (args.eventPrefix) {
      const prefix = args.eventPrefix
      rows = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_event', (q) => q.gte('event', prefix).lt('event', `${prefix}\uffff`))
        .order('desc')
        .filter((q) => q.gte(q.field('createdAt'), since))
        .take(limit)
    } else if (args.level) {
      const level = args.level
      rows = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_level', (q) => q.eq('level', level))
        .order('desc')
        .filter((q) => q.gte(q.field('createdAt'), since))
        .take(limit)
    } else {
      rows = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_event')
        .order('desc')
        .filter((q) => q.gte(q.field('createdAt'), since))
        .take(limit)
    }

    return rows.map((doc) => ({
      at: new Date(doc.createdAt).toISOString(),
      level: doc.level,
      event: doc.event,
      message: doc.message,
      platform: doc.platform,
      appVersion: doc.appVersion,
      sessionId: doc.sessionId,
      userId: doc.userId,
      data: doc.data,
      device: doc.device,
    }))
  },
})

/**
 * Purge log entries older than MAX_RETENTION_DAYS.
 * Invoked daily by a scheduled cron job.
 */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000
    let deleted = 0

    // Scan purgeable retention buckets only. Forensic rows are intentionally
    // retained indefinitely and should not block old standard logs from being
    // reached by this capped cleanup query.
    for (const level of LOG_LEVELS) {
      for (const retention of PURGEABLE_RETENTIONS) {
        const oldEntries = await ctx.db
          .query('clientLogs')
          .withIndex('by_log_retention_level', (q) =>
            q.eq('retention', retention).eq('level', level),
          )
          .filter((q) => q.lt(q.field('createdAt'), cutoff))
          .take(500)

        for (const entry of oldEntries) {
          await ctx.db.delete(entry._id)
          deleted++
        }
      }
    }

    return { deleted, cutoff }
  },
})
