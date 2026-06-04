/**
 * Admin Dashboard — read-only stats queries.
 *
 * All queries require admin access (user.role === 'admin').
 * Returns typed, documented results for the admin dashboard UI.
 */

import { v } from 'convex/values'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'

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

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Subscription stats: total users, breakdown by tier, active this week, new
 * this week.
 */
export const getSubscriptionStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const users = await ctx.db.query('users').collect()
    const now = Date.now()
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const weekAgo = now - weekMs

    let free = 0
    let plus = 0
    let premium = 0
    let pro = 0
    let activeThisWeek = 0
    let newThisWeek = 0

    for (const user of users) {
      switch (user.forcedTier) {
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

      // Active = user has updatedAt within the last week
      if (user.updatedAt && user.updatedAt >= weekAgo) {
        activeThisWeek++
      }

      // New this week = user created within last 7 days
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

    let active = 0
    let grace = 0
    let inactive = 0
    let archived = 0
    let publicCount = 0
    let privateCount = 0

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
        // 'frozen' is a valid status not in the requested stats - count under inactive
        case 'frozen':
          inactive++
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
      byStatus: { active, grace, inactive, archived },
      publicCount,
      privateCount,
    }
  },
})

/**
 * Bondfire stats: total bondfires, responses this week, avg responses per
 * bondfire.
 */
export const getBondfireStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const bondfires = await ctx.db.query('bondfires').collect()
    const videos = await ctx.db.query('bondfireVideos').collect()
    const now = Date.now()
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const weekAgo = now - weekMs

    const responsesThisWeek = videos.filter((v) => v.createdAt >= weekAgo).length

    const avgResponses = bondfires.length > 0 ? videos.length / bondfires.length : 0

    return {
      total: bondfires.length,
      responsesThisWeek,
      avgResponsesPerBondfire: Math.round(avgResponses * 100) / 100,
    }
  },
})

/**
 * Recent reconciliation log entries, optionally filtered by last N days.
 * Defaults to 14 days.
 */
export const getReconciliationHistory = query({
  args: {
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const days = args.days ?? 14
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    const logs = await ctx.db
      .query('reconciliationLog')
      .withIndex('by_created')
      .order('desc')
      .collect()

    return logs.filter((l) => l.createdAt >= cutoff)
  },
})

/**
 * Recent user signups, limited to the last N days (default 7), max 50 results.
 * Returns name, tier, and createdAt for each user.
 */
export const getRecentSignups = query({
  args: {
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const days = args.days ?? 7
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    // No by_created index on users, so collect and filter/sort in memory.
    const allUsers = await ctx.db.query('users').collect()

    const filtered = allUsers
      .filter((u) => u.createdAt && u.createdAt >= cutoff)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 50)

    return filtered.map((user) => ({
      _id: user._id,
      name: user.name ?? user.displayName ?? null,
      tier: user.forcedTier ?? 'free',
      createdAt: user.createdAt ?? null,
    }))
  },
})
