import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { type SubscriptionTier, TIER_RANK } from './entitlements'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const MAX_LOOKBACK_DAYS = 90
const DEFAULT_REPORT_DAYS = 30
const MAX_RECENT_REPORTS = 100
const DEFAULT_RECONCILIATION_DAYS = 14
const MAX_RECONCILIATION_RESULTS = 200
const DEFAULT_SIGNUP_DAYS = 7
const MAX_RECENT_SIGNUPS = 50

type TierCounts = Record<SubscriptionTier, number>

function emptyTierCounts(): TierCounts {
  return { free: 0, plus: 0, premium: 0, pro: 0 }
}

function clampLookbackDays(days: number | undefined, defaultDays: number): number {
  if (days === undefined || !Number.isFinite(days)) {
    return defaultDays
  }

  return Math.min(Math.max(Math.trunc(days), 1), MAX_LOOKBACK_DAYS)
}

function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return defaultLimit
  }

  return Math.min(Math.max(Math.trunc(limit), 1), maxLimit)
}

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

function subscriptionsByUser(
  subscriptions: Doc<'subscriptions'>[],
): Map<Doc<'users'>['_id'], Doc<'subscriptions'>[]> {
  const byUser = new Map<Doc<'users'>['_id'], Doc<'subscriptions'>[]>()

  for (const subscription of subscriptions) {
    const existing = byUser.get(subscription.userId)
    if (existing) {
      existing.push(subscription)
    } else {
      byUser.set(subscription.userId, [subscription])
    }
  }

  return byUser
}

function getEffectiveTier(
  user: Doc<'users'>,
  userSubscriptions: Doc<'subscriptions'>[] | undefined,
  now: number,
): SubscriptionTier {
  if (user.forcedTier) {
    return user.forcedTier
  }

  return (userSubscriptions ?? []).reduce<SubscriptionTier>((highest, subscription) => {
    const isActive =
      subscription.verificationStatus === 'verified' &&
      (subscription.status === 'active' || subscription.status === 'trialing') &&
      (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now)

    if (!isActive) {
      return highest
    }

    return TIER_RANK[subscription.tier] > TIER_RANK[highest] ? subscription.tier : highest
  }, 'free')
}

/**
 * Subscription stats: total users, breakdown by tier, active this week, new
 * this week. Tier counts use effective entitlement tier, including active
 * verified store subscriptions and admin-forced overrides.
 */
export const getSubscriptionStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const now = Date.now()
    const weekAgo = now - WEEK_MS
    const users = await ctx.db.query('users').collect()
    const subscriptions = await ctx.db.query('subscriptions').collect()
    const subscriptionsLookup = subscriptionsByUser(subscriptions)

    const byTier = emptyTierCounts()
    let activeThisWeek = 0
    let newThisWeek = 0

    for (const user of users) {
      const tier = getEffectiveTier(user, subscriptionsLookup.get(user._id), now)
      byTier[tier]++

      if (user.updatedAt && user.updatedAt >= weekAgo) {
        activeThisWeek++
      }

      if (user.createdAt && user.createdAt >= weekAgo) {
        newThisWeek++
      }
    }

    return {
      totalUsers: users.length,
      byTier,
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
    let frozen = 0
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
        case 'frozen':
          frozen++
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
 */
export const getRecentReports = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const days = clampLookbackDays(args.days, DEFAULT_REPORT_DAYS)
    const cutoff = Date.now() - days * DAY_MS
    const limit = clampLimit(args.limit, MAX_RECENT_REPORTS, MAX_RECENT_REPORTS)
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
 * Bondfire stats: total bondfires, responses this week, avg responses per
 * bondfire.
 */
export const getBondfireStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

    const bondfires = await ctx.db.query('bondfires').collect()
    const videos = await ctx.db.query('bondfireVideos').collect()
    const weekAgo = Date.now() - WEEK_MS

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
 * Defaults to 14 days and caps results to the newest 200 entries.
 */
export const getReconciliationHistory = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const days = clampLookbackDays(args.days, DEFAULT_RECONCILIATION_DAYS)
    const cutoff = Date.now() - days * DAY_MS
    const limit = clampLimit(args.limit, MAX_RECONCILIATION_RESULTS, MAX_RECONCILIATION_RESULTS)

    return ctx.db
      .query('reconciliationLog')
      .withIndex('by_created', (q) => q.gte('createdAt', cutoff))
      .order('desc')
      .take(limit)
  },
})

/**
 * Restore admin-owned camps stuck in grace back to active status.
 * Admin-owned camps are exempt from kindling consumption — this fixes
 * camps that entered grace before the exemption was added.
 */
export const restoreAdminGraceCamps = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const now = Date.now()
    const allCamps = await ctx.db.query('camps').collect()
    const graceCamps = allCamps.filter((c) => c.status === 'grace')

    // Fetch owner docs to check admin status
    const ownerIds = [
      ...new Set(graceCamps.map((c) => c.ownerId).filter(Boolean)),
    ] as Doc<'users'>['_id'][]
    const ownerDocs = await Promise.all(ownerIds.map((id) => ctx.db.get(id)))
    const ownerIsAdmin = new Map<Doc<'users'>['_id'], boolean>()
    for (const doc of ownerDocs) {
      if (doc) {
        ownerIsAdmin.set(doc._id, doc.isAdmin === true || doc.role === 'admin')
      }
    }

    const restored: string[] = []
    for (const camp of graceCamps) {
      if (camp.ownerId && ownerIsAdmin.get(camp.ownerId) === true) {
        await ctx.db.patch(camp._id, {
          status: 'active',
          gracePeriodStart: undefined,
          gracePeriodEnd: undefined,
          updatedAt: now,
        })
        restored.push(camp.name)
      }
    }

    return { restored, count: restored.length }
  },
})

export const getRecentSignups = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const now = Date.now()
    const days = clampLookbackDays(args.days, DEFAULT_SIGNUP_DAYS)
    const cutoff = now - days * DAY_MS
    const limit = clampLimit(args.limit, MAX_RECENT_SIGNUPS, MAX_RECENT_SIGNUPS)
    const recentUsers = await ctx.db
      .query('users')
      .withIndex('by_created', (q) => q.gte('createdAt', cutoff))
      .order('desc')
      .take(limit)

    const subscriptions = await ctx.db.query('subscriptions').collect()
    const subscriptionsLookup = subscriptionsByUser(subscriptions)

    return recentUsers.map((user) => ({
      _id: user._id,
      name: user.name ?? user.displayName ?? null,
      tier: getEffectiveTier(user, subscriptionsLookup.get(user._id), now),
      createdAt: user.createdAt ?? null,
    }))
  },
})
