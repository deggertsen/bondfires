/**
 * Server-side telemetry.
 *
 * Lets backend mutations/actions write into the same `clientLogs` table the
 * mobile client reports to, so triage sees backend failures (with real error
 * detail) instead of an opaque, masked "Server Error". Mutations call
 * {@link logServerEvent} directly; actions call {@link recordServerEvent} via
 * `ctx.runMutation`.
 */

import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'

const MAX_SERIALIZE_DEPTH = 5
const MAX_SERIALIZE_KEYS = 50

const SERVER_LOG_LEVEL = v.union(
  v.literal('error'),
  v.literal('warn'),
  v.literal('info'),
  v.literal('breadcrumb'),
)

export type ServerLogLevel = 'error' | 'warn' | 'info' | 'breadcrumb'

export interface ServerLogEntry {
  level: ServerLogLevel
  event: string
  message: string
  data?: unknown
  userId?: Id<'users'>
  /** 'forensic' is retained indefinitely; 'standard' (default) is purged at 30d. */
  retention?: 'standard' | 'forensic'
}

export function serializeServerLogData(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === 'undefined') return undefined
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value)
  }

  if (value instanceof Error) {
    return serializeServerLogData(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      depth + 1,
      seen,
    )
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '[MaxDepth]'
  }

  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => {
      const serialized = serializeServerLogData(item, depth + 1, seen)
      return typeof serialized === 'undefined' ? null : serialized
    })
  }

  const output: Record<string, unknown> = {}
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    if (index >= MAX_SERIALIZE_KEYS) {
      output.__truncated = true
      break
    }

    const serialized = serializeServerLogData(item, depth + 1, seen)
    if (typeof serialized !== 'undefined') {
      output[key] = serialized
    }
  }

  return output
}

/**
 * Insert a server-originated telemetry row. Best-effort: never throws, so a
 * logging failure can't take down the mutation that called it.
 */
export async function logServerEvent(ctx: MutationCtx, entry: ServerLogEntry): Promise<void> {
  try {
    await ctx.db.insert('clientLogs', {
      userId: entry.userId,
      level: entry.level,
      event: entry.event,
      message: entry.message,
      data: serializeServerLogData(entry.data),
      platform: 'server',
      appVersion: undefined,
      sessionId: undefined,
      retention: entry.retention ?? 'standard',
      createdAt: Date.now(),
    })
  } catch {
    // Swallow — telemetry must never break the caller.
  }
}

/** Action-callable wrapper around {@link logServerEvent}. */
export const recordServerEvent = internalMutation({
  args: {
    level: SERVER_LOG_LEVEL,
    event: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    userId: v.optional(v.id('users')),
    retention: v.optional(v.union(v.literal('standard'), v.literal('forensic'))),
  },
  handler: async (ctx, args) => {
    await logServerEvent(ctx, {
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      userId: args.userId,
      retention: args.retention,
    })
  },
})
