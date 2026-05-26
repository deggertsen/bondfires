/**
 * Admin mutations for managing forced subscription tiers.
 *
 * Allows administrators to override subscription tiers for specific users
 * for QA and app store review purposes.  All mutations require `isAdmin: true`.
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

const subscriptionTier = v.union(
  v.literal('free'),
  v.literal('plus'),
  v.literal('premium'),
  v.literal('pro'),
)

/**
 * Search for users by email prefix.
 *
 * Returns up to 20 matching users with their email, name, and current forcedTier.
 */
export const adminSearchUsers = query({
  args: {
    emailQuery: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUserId = await auth.getUserId(ctx)
    if (!currentUserId) {
      throw new Error('Not authenticated')
    }

    const currentUser = await ctx.db.get(currentUserId)
    if (!currentUser?.isAdmin) {
      throw new Error('Admin access required')
    }

    const query = args.emailQuery.toLowerCase().trim()
    const allUsers = await ctx.db.query('users').take(50)

    const matches = allUsers
      .filter((user) => user.email?.toLowerCase().includes(query))
      .slice(0, 20)
      .map((user) => ({
        _id: user._id,
        email: user.email,
        name: user.name,
        forcedTier: user.forcedTier ?? null,
      }))

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
    const currentUserId = await auth.getUserId(ctx)
    if (!currentUserId) {
      throw new Error('Not authenticated')
    }

    const currentUser = await ctx.db.get(currentUserId)
    if (!currentUser?.isAdmin) {
      throw new Error('Admin access required')
    }

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
    return {
      _id: updatedUser?._id,
      email: updatedUser?.email,
      name: updatedUser?.name,
      forcedTier: updatedUser?.forcedTier ?? null,
    }
  },
})
