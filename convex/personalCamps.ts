import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { internalMutation, query } from './_generated/server'
import { auth } from './auth'

// ── Helpers ────────────────────────────────────────────────────────────────

function personalCampName(displayName?: string, name?: string) {
  const base = displayName || name || 'Someone'
  return `${base}'s Fire`
}

// ── Internal Mutations ─────────────────────────────────────────────────────

/**
 * Get or create a personal camp for a given user and tier.
 * No auth check — callers are responsible for authorization.
 *
 * - Free tier: returns null (no personal camp for free users).
 * - Paid tier: returns existing camp or creates a new one.
 */
export const internalGetOrCreatePersonalCamp = internalMutation({
  args: {
    userId: v.id('users'),
    tier: v.union(
      v.literal('free'),
      v.literal('plus'),
      v.literal('premium'),
      v.literal('pro'),
    ),
  },
  handler: async (ctx, args) => {
    if (args.tier === 'free') {
      return null
    }

    const existing = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.userId))
      .first()

    if (existing) {
      return existing
    }

    const user = await ctx.db.get(args.userId)
    if (!user) {
      return null
    }

    const now = Date.now()
    const name = personalCampName(user.displayName, user.name)
    const campId = await ctx.db.insert('personalCamps', {
      ownerId: args.userId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return {
      _id: campId,
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
    const camp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first()

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
    const camp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first()

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
 * Authenticated users call this to retrieve their personal camp.
 * Returns null if the user has no personal camp or is on Free tier.
 */
export const getMyPersonalCamp = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const existing = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first()

    return existing ?? null
  },
})
