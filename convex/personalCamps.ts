/**
 * Personal Camps — 1:1 spaces for paid subscribers.
 *
 * Every Plus/Premium/Pro user gets a single personal camp automatically
 * created on first subscription activation. The camp freezes on downgrade
 * to Free and unfreezes on re-subscribe.
 */
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, PAID_TIERS } from './entitlements'
import { throwUserError } from './errors'

// ── Helpers ────────────────────────────────────────────────────────────────

function personalCampName(displayName?: string, name?: string) {
  const base = displayName || name || 'Someone'
  return `${base}'s Fire`
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get the current user's personal camp.
 * Returns null if none exists (user is Free tier or hasn't activated yet).
 */
export const getMyPersonalCamp = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    return await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first()
  },
})

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Get or create the current user's personal camp.
 *
 * - Plus/Premium/Pro: auto-creates if none exists, unfreezes if frozen.
 * - Free: throws an error.
 */
export const getOrCreate = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const user = await ctx.db.get(userId)
    if (!user) {
      throwUserError('User not found')
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError(
        'Personal Camps require a Plus, Premium, or Pro subscription.',
      )
    }

    const existing = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first()

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

    const now = Date.now()
    const name = personalCampName(user.displayName, user.name)
    const campId = await ctx.db.insert('personalCamps', {
      ownerId: userId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return {
      _id: campId,
      ownerId: userId,
      name,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    }
  },
})

// ── Internal Mutations — called from subscription flow ────────────────────

/**
 * Called when a user upgrades to a paid tier.
 * Creates a personal camp if none exists, or unfreezes an existing frozen one.
 */
export const internalHandlePersonalCampUpgrade = internalMutation({
  args: {
    userId: v.id('users'),
    newTier: v.union(
      v.literal('free'),
      v.literal('plus'),
      v.literal('premium'),
      v.literal('pro'),
    ),
  },
  handler: async (ctx, args) => {
    if (!PAID_TIERS.includes(args.newTier)) {
      return null
    }

    const user = await ctx.db.get(args.userId)
    if (!user) {
      return null
    }

    const existing = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.userId))
      .first()

    if (existing) {
      if (existing.status === 'frozen') {
        const now = Date.now()
        await ctx.db.patch(existing._id, {
          status: 'active',
          frozenAt: undefined,
          updatedAt: now,
        })
      }
      return existing._id
    }

    const now = Date.now()
    const name = personalCampName(user.displayName, user.name)
    return await ctx.db.insert('personalCamps', {
      ownerId: args.userId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * Called when a user downgrades to Free.
 * Freezes the personal camp.
 */
export const internalHandlePersonalCampDowngrade = internalMutation({
  args: {
    userId: v.id('users'),
    newTier: v.union(
      v.literal('free'),
      v.literal('plus'),
      v.literal('premium'),
      v.literal('pro'),
    ),
  },
  handler: async (ctx, args) => {
    if (args.newTier !== 'free') {
      return null
    }

    const camp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.userId))
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
