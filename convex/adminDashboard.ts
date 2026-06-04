/**
 * Admin Dashboard — read-only stats queries.
 *
 * All queries require admin access (user.role === 'admin' or isAdmin).
 * Returns typed, documented results for the admin dashboard UI.
 */

import { v } from 'convex/values'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RECENT_LIMIT = 50
const MAX_RECENT_LIMIT = 100

// ── Helpers ────────────────────────────────────────────────────────────────

async function requireAdmin(ctx: QueryCtx): Promise<void> {
  const currentUserId = await auth.getUserId(ctx)
  if (!currentUserId) {
    throw new Error('Not authenticated')
  }

  const currentUser = await ctx.db.get(currentUserId)
  if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
    throw new Error('Admin access required')
  }
}

function normalizeLimit(requestedLimit: number | undefined) {
  return Math.min(Math.max(Math.trunc(requestedLimit ?? DEFAULT_RECENT_LIMIT), 1), MAX_RECENT_LIMIT)
}

function normalizeDays(days: number | undefined, defaultDays: number) {
  return Math.max(Math.trunc(days ?? defaultDays), 1)
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Subscription stats: total users, breakdown by effective tier (forcedTier
 * overrides subscriptions), active this week, new this week.
 */
export const getSubscriptionStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const users = await ctx.db.query('users').collect()
    const now = Date.now()
    const weekAgo = now - WEEK_MS

    // Build active-subscription tier map (mirrors entitlements.getActiveSubscriptionTier)
    const subs = await ctx.db.query('subscriptions').collect()
    const TIER_RANK: Record<string, number> = { free: 0, plus: 1, premium: 2, pro: 3 }
    const activeSubByUser = new Map<string, string>()
    for (const sub of subs) {
      if (sub.verificationStatus !== 'verified') continue
      if (sub.status !== 'active' && sub.status !== 'trialing') continue
      if (sub.currentPeriodEnd && sub.currentPeriodEnd <= now) continue
      const cur = activeSubByUser.get(sub.userId)
      if (!cur || TIER_RANK[sub.tier] > (TIER_RANK[cur] ?? 0)) {
        activeSubByUser.set(sub.userId, sub.tier)
      }
    }

    let free = 0
    let plus = 0
    let premium = 0
    let pro = 0
    let activeThisWeek = 0
    let newThisWeek = 0

    for (const user of users) {
      const tier = user.forcedTier ?? activeSubByUser.get(user._id) ?? 'free'
      switch (tier) {
        case 'free':
          free++
          break
        case 'plus':
          plus++
          break
        case 'premium':
          premium++
          break
        case 'pro':
          pro++
          break
        default:
          free++
          break
      }

      if (user.updatedAt && user.updatedAt >= weekAgo) {
        activeThisWeek++
      }
      if (user.createdAt && user.createdAt >= weekAgo) {
        newThisWeek++
      }
    }

    return {
      totalUsers: users.length,
      byTier: { free, plus, premium, pro },
      activeThisWeek,
      newThisWeek,
    }
  },
})

/**
 * Camp stats: total camps by status, public vs private breakdown.
 */
export const getCampStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const camps = await ctx.db.query('camps').collect()

    let active = 0,
      frozen = 0,
      grace = 0,
      inactive = 0,
      archived = 0
    let publicCount = 0,
      privateCount = 0

    for (const camp of camps) {
      switch (camp.status) {
        case 'active':
          active++
          break
        case 'grace':
          grace++
          break
        case 'inactive':
          inactive++
          break
        case 'archived':
          archived++
          break
        case 'frozen':
          frozen++
          break
      }
      if (camp.access === 'open' || camp.access === 'approval') {
        publicCount++
      } else {
        privateCount++
      }
    }

    return {
      total: camps.length,
      byStatus: { active, frozen, grace, inactive, archived },
      publicCount,
      privateCount,
    }
  },
})

/**
 * Recent pending reports on bondfires/comments, sorted by recency.
 * Optionally filtered by last N days (default 30).
 */
export const getRecentReports = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const cutoff = Date.now() - normalizeDays(args.days, 30) * DAY_MS
    const limit = normalizeLimit(args.limit)
    const pending = await ctx.db
      .query('reports')
      .withIndex('by_status', (q) => q.eq('status', 'pending').gte('createdAt', cutoff))
      .order('desc')
      .take(limit)

    return await Promise.all(
      pending.map(async (report) => {
        const reporter = await ctx.db.get(report.reporterUserId)
        const videoOwner = await ctx.db.get(report.videoOwnerId)
        return {
          ...report,
          reporterName: reporter?.displayName ?? reporter?.name ?? null,
          videoOwnerName: videoOwner?.displayName ?? videoOwner?.name ?? null,
        }
      }),
    )
  },
})

/**
 * Bondfire stats: total bondfires, responses this week, avg responses.
 */
export const getBondfireStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const bondfires = await ctx.db.query('bondfires').collect()
    const videos = await ctx.db.query('bondfireVideos').collect()
    const now = Date.now()
    const weekAgo = now - WEEK_MS

    const responsesThisWeek = videos.filter((v) => v.createdAt >= weekAgo).length
    const avg = bondfires.length > 0 ? videos.length / bondfires.length : 0

    return {
      total: bondfires.length,
      responsesThisWeek,
      avgResponsesPerBondfire: Math.round(avg * 100) / 100,
    }
  },
})

/**
 * Recent reconciliation log entries, optionally filtered by last N days.
 */
export const getReconciliationHistory = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const cutoff = Date.now() - normalizeDays(args.days, 14) * DAY_MS
    const limit = normalizeLimit(args.limit)

    return ctx.db
      .query('reconciliationLog')
      .withIndex('by_created', (q) => q.gte('createdAt', cutoff))
      .order('desc')
      .take(limit)
  },
})

/**
 * Recent user signups, limited to last N days (default 7), max 50 results.
 */
export const getRecentSignups = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const cutoff = Date.now() - normalizeDays(args.days, 7) * DAY_MS
    const limit = normalizeLimit(args.limit)

    const recentUsers = await ctx.db
      .query('users')
      .withIndex('by_created', (q) => q.gte('createdAt', cutoff))
      .order('desc')
      .take(limit)

    return recentUsers.map((u) => ({
      _id: u._id,
      name: u.name ?? u.displayName ?? null,
      tier: u.forcedTier ?? 'free',
      createdAt: u.createdAt ?? null,
    }))
  },
})
