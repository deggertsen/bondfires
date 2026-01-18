/**
 * Reviewer Account Management
 *
 * These mutations help manage test accounts for app store reviewers
 * (Google Play, Apple App Store). Reviewer accounts are pre-verified
 * so reviewers don't need to complete email verification.
 *
 * USAGE:
 * 1. Create an account normally via the app's signup flow
 * 2. Run `setupReviewerAccount` with the email to mark it as verified
 * 3. Provide the credentials to the app store reviewer portal
 *
 * Run via Convex Dashboard or CLI:
 *   npx convex run reviewerAccounts:setupReviewerAccount '{"email": "googlereview@bondfires.org"}'
 *   npx convex run reviewerAccounts:listReviewerAccounts
 *   npx convex run reviewerAccounts:revokeReviewerAccess '{"email": "googlereview@bondfires.org"}'
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/**
 * Setup a reviewer account by marking it as email-verified.
 * The account must already exist (created via normal signup).
 *
 * @param email - The email of the account to setup as reviewer
 * @returns The updated user record
 */
export const setupReviewerAccount = mutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim()

    // Find the user by email
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .first()

    if (!user) {
      throw new Error(
        `No user found with email: ${email}. Please create the account via the app's signup flow first.`,
      )
    }

    // Check if already a reviewer
    if (user.isReviewerAccount && user.emailVerified) {
      return {
        success: true,
        message: 'Account is already set up as a reviewer account',
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
          isReviewerAccount: user.isReviewerAccount,
        },
      }
    }

    // Mark as verified reviewer account
    await ctx.db.patch(user._id, {
      emailVerified: true,
      emailVerificationTime: Date.now(),
      isReviewerAccount: true,
      updatedAt: Date.now(),
    })

    const updatedUser = await ctx.db.get(user._id)

    return {
      success: true,
      message: 'Reviewer account setup complete. Email verification bypassed.',
      user: {
        id: updatedUser?._id,
        email: updatedUser?.email,
        name: updatedUser?.name,
        emailVerified: updatedUser?.emailVerified,
        isReviewerAccount: updatedUser?.isReviewerAccount,
      },
    }
  },
})

/**
 * List all reviewer accounts.
 *
 * @returns Array of reviewer accounts
 */
export const listReviewerAccounts = query({
  args: {},
  handler: async (ctx) => {
    // Get all users and filter for reviewer accounts
    // Note: In a larger app, you'd want an index on isReviewerAccount
    const allUsers = await ctx.db.query('users').collect()

    const reviewerAccounts = allUsers
      .filter((user) => user.isReviewerAccount === true)
      .map((user) => ({
        id: user._id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        isReviewerAccount: user.isReviewerAccount,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }))

    return {
      count: reviewerAccounts.length,
      accounts: reviewerAccounts,
    }
  },
})

/**
 * Revoke reviewer access from an account.
 * This removes the reviewer flag but keeps the account intact.
 *
 * @param email - The email of the reviewer account
 * @returns Result of the operation
 */
export const revokeReviewerAccess = mutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim()

    // Find the user by email
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .first()

    if (!user) {
      throw new Error(`No user found with email: ${email}`)
    }

    if (!user.isReviewerAccount) {
      return {
        success: true,
        message: 'Account is not marked as a reviewer account',
      }
    }

    // Remove reviewer flag (but keep emailVerified as-is)
    await ctx.db.patch(user._id, {
      isReviewerAccount: false,
      updatedAt: Date.now(),
    })

    return {
      success: true,
      message: `Reviewer access revoked for ${email}`,
    }
  },
})

/**
 * Delete a reviewer account completely.
 * Use with caution - this permanently deletes the account and all associated data.
 *
 * @param email - The email of the reviewer account to delete
 * @returns Result of the operation
 */
export const deleteReviewerAccount = mutation({
  args: {
    email: v.string(),
    confirmDelete: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (!args.confirmDelete) {
      throw new Error('You must set confirmDelete: true to delete an account')
    }

    const email = args.email.toLowerCase().trim()

    // Find the user by email
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email))
      .first()

    if (!user) {
      throw new Error(`No user found with email: ${email}`)
    }

    if (!user.isReviewerAccount) {
      throw new Error(
        `Account ${email} is not a reviewer account. Use the regular account deletion flow for non-reviewer accounts.`,
      )
    }

    // Delete associated data (similar to users.deleteAccount but for admin use)
    const userId = user._id

    // Delete user's videos
    const userVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const video of userVideos) {
      const bondfire = await ctx.db.get(video.bondfireId)
      if (bondfire) {
        await ctx.db.patch(video.bondfireId, {
          videoCount: Math.max(0, bondfire.videoCount - 1),
          updatedAt: Date.now(),
        })
      }
      await ctx.db.delete(video._id)
    }

    // Delete user's bondfires
    const userBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const bondfire of userBondfires) {
      const bondfireResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of bondfireResponses) {
        await ctx.db.delete(response._id)
      }
      await ctx.db.delete(bondfire._id)
    }

    // Delete watch events
    const watchEvents = await ctx.db
      .query('watchEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const event of watchEvents) {
      await ctx.db.delete(event._id)
    }

    // Delete device tokens
    const deviceTokens = await ctx.db
      .query('deviceTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const token of deviceTokens) {
      await ctx.db.delete(token._id)
    }

    // Delete auth sessions
    const authSessions = await ctx.db
      .query('authSessions')
      .withIndex('userId', (q) => q.eq('userId', userId))
      .collect()

    for (const session of authSessions) {
      const refreshTokens = await ctx.db
        .query('authRefreshTokens')
        .withIndex('sessionId', (q) => q.eq('sessionId', session._id))
        .collect()

      for (const token of refreshTokens) {
        await ctx.db.delete(token._id)
      }
      await ctx.db.delete(session._id)
    }

    // Delete auth accounts
    const authAccounts = await ctx.db
      .query('authAccounts')
      .withIndex('userIdAndProvider', (q) => q.eq('userId', userId))
      .collect()

    for (const account of authAccounts) {
      await ctx.db.delete(account._id)
    }

    // Delete the user
    await ctx.db.delete(userId)

    return {
      success: true,
      message: `Reviewer account ${email} has been permanently deleted`,
    }
  },
})
