/**
 * Admin mutations for managing forced subscription tiers.
 *
 * Allows administrators to override subscription tiers for specific users
 * for QA and app store review purposes.  All mutations require `isAdmin: true`.
 */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

const subscriptionTier = v.union(
  v.literal('free'),
  v.literal('plus'),
  v.literal('premium'),
  v.literal('pro'),
)

function adminUserResult(user: Doc<'users'>) {
  return {
    _id: user._id,
    email: user.email,
    name: user.name,
    forcedTier: user.forcedTier ?? null,
  }
}

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const currentUserId = await auth.getUserId(ctx)
  if (!currentUserId) {
    throw new Error('Not authenticated')
  }

  const currentUser = await ctx.db.get(currentUserId)
  if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
    throw new Error('Admin access required')
  }

  return { currentUserId, currentUser }
}

/**
 * Search for users by email.
 *
 * Returns up to 20 matching users with their email, name, and current forcedTier.
 */
export const adminSearchUsers = query({
  args: {
    emailQuery: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const emailQuery = args.emailQuery.toLowerCase().trim()
    if (emailQuery.length < 2) {
      return { users: [] }
    }

    const exactMatch = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', emailQuery))
      .first()
    const searchMatches = await ctx.db
      .query('users')
      .withSearchIndex('search_email', (q) => q.search('email', emailQuery))
      .take(20)

    const matchesById = new Map<Doc<'users'>['_id'], Doc<'users'>>()
    if (exactMatch) {
      matchesById.set(exactMatch._id, exactMatch)
    }
    for (const user of searchMatches) {
      matchesById.set(user._id, user)
    }

    const matches = Array.from(matchesById.values()).slice(0, 20).map(adminUserResult)

    return { users: matches }
  },
})

/**
 * Set or clear a forced subscription tier for a user by email.
 *
 * Pass `tier: null` to clear the override and revert to store-based entitlements.
 * Pass a SubscriptionTier value to force that tier regardless of store purchases.
 */
export const adminSetForcedTier = mutation({
  args: {
    email: v.string(),
    tier: v.union(v.null(), subscriptionTier),
  },
  handler: async (ctx, args) => {
    const { currentUserId, currentUser } = await requireAdmin(ctx)

    const email = args.email.toLowerCase().trim()

    const targetUser = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .first()

    if (!targetUser) {
      throw new Error(`No user found with email: ${email}`)
    }

    const now = Date.now()
    const adminEmail = currentUser.email ?? 'unknown'

    if (args.tier === null) {
      await ctx.db.patch(targetUser._id, {
        forcedTier: undefined,
        updatedAt: now,
      })

      await ctx.db.insert('tierAuditLog', {
        action: 'cleared',
        targetUserId: targetUser._id,
        targetEmail: email,
        tier: undefined,
        adminUserId: currentUserId,
        adminEmail,
        timestamp: now,
      })
    } else {
      await ctx.db.patch(targetUser._id, {
        forcedTier: args.tier,
        updatedAt: now,
      })

      await ctx.db.insert('tierAuditLog', {
        action: 'set',
        targetUserId: targetUser._id,
        targetEmail: email,
        tier: args.tier,
        adminUserId: currentUserId,
        adminEmail,
        timestamp: now,
      })
    }

    const updatedUser = await ctx.db.get(targetUser._id)
    return updatedUser ? adminUserResult(updatedUser) : null
  },
})
