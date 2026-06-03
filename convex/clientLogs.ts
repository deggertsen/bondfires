/**
 * Client-side telemetry logging.
 *
 * Accepts breadcrumbs, errors, and warnings from the React Native app
 * and persists them for debugging and support purposes.
 */

import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { auth } from './auth'

const LOG_LEVELS = ['error', 'warn', 'info', 'breadcrumb'] as const
const MAX_BATCH_SIZE = 20
const MAX_RETENTION_DAYS = 30

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
    createdAt: doc.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Public mutations
// ---------------------------------------------------------------------------

/**
 * Insert a single client log entry.
 * Accepts an optional userId — the mutation also attaches the authenticated
 * user if available and no explicit userId was provided.
 */
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
  },
  handler: async (ctx, args) => {
    const resolvedUserId = args.userId ?? (await getCurrentUserId(ctx))

    return await ctx.db.insert('clientLogs', {
      userId: resolvedUserId,
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      platform: args.platform,
      appVersion: args.appVersion,
      sessionId: args.sessionId,
      createdAt: args.createdAt,
    })
  },
})

/**
 * Batch-insert up to 20 log entries in a single mutation.
 * Each entry's userId is resolved independently (authenticated user
 * override, or kept null when not authenticated).
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
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.entries.length > MAX_BATCH_SIZE) {
      throw new Error(`Cannot batch more than ${MAX_BATCH_SIZE} entries per call`)
    }

    const currentUserId = await getCurrentUserId(ctx)
    const ids: Id<'clientLogs'>[] = []

    for (const entry of args.entries) {
      const resolvedUserId = entry.userId ?? currentUserId
      const id = await ctx.db.insert('clientLogs', {
        userId: resolvedUserId,
        level: entry.level,
        event: entry.event,
        message: entry.message,
        data: entry.data,
        platform: entry.platform,
        appVersion: entry.appVersion,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
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
      v.union(
        v.literal('error'),
        v.literal('warn'),
        v.literal('info'),
        v.literal('breadcrumb'),
      ),
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

    const pageSize = Math.min(args.limit ?? 50, 100)

    // Pick the most selective index
    if (args.userId) {
      const results = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_user', (q) => q.eq('userId', args.userId!))
        .order('desc')
        .take(pageSize)

      return { entries: results.map(logEntry), cursor: null }
    }

    if (args.level) {
      const results = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_level', (q) => q.eq('level', args.level!))
        .order('desc')
        .take(pageSize)

      return { entries: results.map(logEntry), cursor: null }
    }

    // Fallback: query by event index
    const prefix = args.eventPrefix ?? ''
    const results = await ctx.db
      .query('clientLogs')
      .withIndex('by_log_event', (q) => {
        if (prefix) {
          return q.gte('event', prefix).lt('event', prefix + '\uffff')
        }
        return q
      })
      .order('desc')
      .take(pageSize)

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
 * Purge log entries older than MAX_RETENTION_DAYS.
 * Invoked daily by a scheduled cron job.
 */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000
    let deleted = 0

    // Scan each level index for old entries
    for (const level of LOG_LEVELS) {
      const oldEntries = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_level', (q) => q.eq('level', level))
        .filter((q) => q.lt(q.field('createdAt'), cutoff))
        .take(500)

      for (const entry of oldEntries) {
        await ctx.db.delete(entry._id)
        deleted++
      }
    }

    return { deleted, cutoff }
  },
})
