import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { throwUserError } from './errors'

export const ABUSE_LIMITS = {
  inviteCodeCreatePerHour: 20,
  directInvitePerHour: 60,
  inviteAttemptPerTenMinutes: 20,
  inviteLookupPerTenMinutes: 30,
  watchEventPerMinute: 60,
} as const

const HOUR_MS = 60 * 60 * 1_000
const TEN_MINUTES_MS = 10 * 60 * 1_000
const MINUTE_MS = 60 * 1_000
const RETENTION_MS = 2 * 24 * 60 * 60 * 1_000

type FixedWindowState = { count: number; windowStartedAt: number } | null

export function getFixedWindowUpdate(
  state: FixedWindowState,
  args: { now: number; limit: number; windowMs: number },
): { allowed: boolean; count: number; windowStartedAt: number; retryAfterMs: number } {
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.windowMs < 1) {
    throw new Error('Invalid fixed-window configuration')
  }
  const windowExpired = !state || args.now - state.windowStartedAt >= args.windowMs
  const windowStartedAt = windowExpired ? args.now : state.windowStartedAt
  const currentCount = windowExpired ? 0 : state.count
  if (currentCount >= args.limit) {
    return {
      allowed: false,
      count: currentCount,
      windowStartedAt,
      retryAfterMs: Math.max(1, windowStartedAt + args.windowMs - args.now),
    }
  }
  return {
    allowed: true,
    count: currentCount + 1,
    windowStartedAt,
    retryAfterMs: 0,
  }
}

async function consumeFixedWindow(
  ctx: MutationCtx,
  args: {
    key: string
    subjectId: Id<'users'>
    category: string
    limit: number
    windowMs: number
    now?: number
  },
) {
  const now = args.now ?? Date.now()
  const existing = await ctx.db
    .query('abuseRateLimits')
    .withIndex('by_key', (q) => q.eq('key', args.key))
    .unique()
  const update = getFixedWindowUpdate(existing, {
    now,
    limit: args.limit,
    windowMs: args.windowMs,
  })
  if (!update.allowed) return update

  if (existing) {
    await ctx.db.patch(existing._id, {
      count: update.count,
      windowStartedAt: update.windowStartedAt,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert('abuseRateLimits', {
      key: args.key,
      subjectType: 'user',
      subjectId: args.subjectId,
      category: args.category,
      count: update.count,
      windowStartedAt: update.windowStartedAt,
      updatedAt: now,
    })
  }
  return update
}

async function enforceUserLimit(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    category: string
    userLimit: number
    windowMs: number
    message: string
  },
) {
  const userResult = await consumeFixedWindow(ctx, {
    key: `${args.category}:user:${args.userId}`,
    subjectId: args.userId,
    category: args.category,
    limit: args.userLimit,
    windowMs: args.windowMs,
  })
  if (!userResult.allowed) throwUserError(args.message)
}

export async function enforceInviteCodeCreationLimit(ctx: MutationCtx, userId: Id<'users'>) {
  await enforceUserLimit(ctx, {
    userId,
    category: 'invite_code_create',
    userLimit: ABUSE_LIMITS.inviteCodeCreatePerHour,
    windowMs: HOUR_MS,
    message: 'Too many invite links created. Try again later.',
  })
}

export async function enforceDirectInviteLimit(ctx: MutationCtx, userId: Id<'users'>) {
  await enforceUserLimit(ctx, {
    userId,
    category: 'direct_invite',
    userLimit: ABUSE_LIMITS.directInvitePerHour,
    windowMs: HOUR_MS,
    message: 'Too many invites sent. Try again later.',
  })
}

export async function enforceInviteAttemptLimit(ctx: MutationCtx, userId: Id<'users'>) {
  await enforceUserLimit(ctx, {
    userId,
    category: 'invite_attempt',
    userLimit: ABUSE_LIMITS.inviteAttemptPerTenMinutes,
    windowMs: TEN_MINUTES_MS,
    message: 'Too many invite attempts. Try again later.',
  })
}

export async function enforceInviteLookupLimit(ctx: MutationCtx, userId: Id<'users'>) {
  await enforceUserLimit(ctx, {
    userId,
    category: 'invite_lookup',
    userLimit: ABUSE_LIMITS.inviteLookupPerTenMinutes,
    windowMs: TEN_MINUTES_MS,
    message: 'Too many invite attempts. Try again later.',
  })
}

export async function enforceWatchEventLimit(ctx: MutationCtx, userId: Id<'users'>) {
  await enforceUserLimit(ctx, {
    userId,
    category: 'watch_event',
    userLimit: ABUSE_LIMITS.watchEventPerMinute,
    windowMs: MINUTE_MS,
    message: 'Too many watch events. Try again shortly.',
  })
}

export const cleanupStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS
    const stale = await ctx.db
      .query('abuseRateLimits')
      .withIndex('by_updated_at', (q) => q.lt('updatedAt', cutoff))
      .take(500)
    for (const row of stale) await ctx.db.delete(row._id)
    return { deleted: stale.length, remainingMayExist: stale.length === 500 }
  },
})

export const cleanupForUser = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('abuseRateLimits')
      .withIndex('by_subject', (q) => q.eq('subjectType', 'user').eq('subjectId', args.userId))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
    return { deleted: rows.length }
  },
})
