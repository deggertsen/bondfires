import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, type SubscriptionTier, TIER_RANK } from './entitlements'

// ── Helpers ────────────────────────────────────────────────────────────────

const subscriptionTierValidator = v.union(
  v.literal('free'),
  v.literal('plus'),
  v.literal('premium'),
  v.literal('pro'),
)

function isPaidTier(tier: SubscriptionTier) {
  return TIER_RANK[tier] > TIER_RANK.free
}

function personalCampName(displayName?: string, name?: string) {
  const base = displayName?.trim() || name?.trim() || 'Someone'
  return `${base}'s Fire`
}

function personalCampPublicId() {
  return `pc_${crypto.randomUUID().replaceAll('-', '')}`
}

async function getPersonalCampByOwner(
  ctx: { db: QueryCtx['db'] | MutationCtx['db'] },
  ownerId: Id<'users'>,
): Promise<Doc<'personalCamps'> | null> {
  return await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
    .first()
}

// ── Internal Mutations ─────────────────────────────────────────────────────

/**
 * Get, activate, or create a personal camp for a given user and tier.
 * No auth check — callers are responsible for authorization.
 *
 * - Free tier: returns null (no personal camp for free users).
 * - Paid tier: returns active existing camp, thaws frozen camp, or creates a new one.
 */
export const internalGetOrCreatePersonalCamp = internalMutation({
  args: {
    userId: v.id('users'),
    tier: subscriptionTierValidator,
  },
  handler: async (ctx, args) => {
    if (!isPaidTier(args.tier)) {
      return null
    }

    const existing = await getPersonalCampByOwner(ctx, args.userId)

    if (existing) {
      if (existing.status === 'frozen') {
        const now = Date.now()
        await ctx.db.patch(existing._id, {
          status: 'active',
          frozenAt: undefined,
          updatedAt: now,
        })

        return {
          ...existing,
          status: 'active' as const,
          frozenAt: undefined,
          updatedAt: now,
        }
      }

      return existing
    }

    const user = await ctx.db.get(args.userId)
    if (!user) {
      return null
    }

    const now = Date.now()
    const name = personalCampName(user.displayName, user.name)
    const publicId = personalCampPublicId()
    const campId = await ctx.db.insert('personalCamps', {
      publicId,
      ownerId: args.userId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return {
      _id: campId,
      publicId,
      ownerId: args.userId,
      name,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    }
  },
})

/**
 * Freeze a personal camp — sets status to "frozen" and records frozenAt.
 * No-op if the camp doesn't exist or is already frozen.
 */
export const freezePersonalCamp = internalMutation({
  args: {
    ownerId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const camp = await getPersonalCampByOwner(ctx, args.ownerId)

    if (!camp || camp.status !== 'active') {
      return null
    }

    const now = Date.now()
    await ctx.db.patch(camp._id, {
      status: 'frozen',
      frozenAt: now,
      updatedAt: now,
    })

    return camp._id
  },
})

/**
 * Unfreeze a personal camp — sets status to "active" and clears frozenAt.
 * No-op if the camp doesn't exist or is already active.
 */
export const unfreezePersonalCamp = internalMutation({
  args: {
    ownerId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const camp = await getPersonalCampByOwner(ctx, args.ownerId)

    if (!camp || camp.status !== 'frozen') {
      return null
    }

    const now = Date.now()
    await ctx.db.patch(camp._id, {
      status: 'active',
      frozenAt: undefined,
      updatedAt: now,
    })

    return camp._id
  },
})

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get the current user's personal camp.
 * Read-only query — returns null if the user hasn't had their camp created yet.
 * Callers should follow up with ensureMyPersonalCamp when null is returned
 * for a paid-tier user.
 * Returns null if the user has no personal camp or is on Free tier.
 */
export const getMyPersonalCamp = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    if (!isPaidTier(tier)) {
      return null
    }

    return await getPersonalCampByOwner(ctx, userId)
  },
})

/**
 * Ensure the current user has an active personal camp.
 * Creates one if missing, re-activates if frozen.
 * Safe to call as a no-op if the camp already exists.
 * Returns null for Free-tier users.
 */
export const ensureMyPersonalCamp = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    if (!isPaidTier(tier)) {
      return null
    }

    const existing = await getPersonalCampByOwner(ctx, userId)

    if (existing) {
      if (existing.status === 'frozen') {
        const now = Date.now()
        await ctx.db.patch(existing._id, {
          status: 'active',
          frozenAt: undefined,
          updatedAt: now,
        })

        return {
          ...existing,
          status: 'active' as const,
          frozenAt: undefined,
          updatedAt: now,
        }
      }

      return existing
    }

    // Paid tier but no camp (admin override, manual assignment, etc.)
    const user = await ctx.db.get(userId)
    if (!user) {
      return null
    }

    const now = Date.now()
    const name = personalCampName(user.displayName, user.name)
    const publicId = personalCampPublicId()
    const campId = await ctx.db.insert('personalCamps', {
      publicId,
      ownerId: userId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return {
      _id: campId,
      publicId,
      ownerId: userId,
      name,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    }
  },
})
