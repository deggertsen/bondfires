/**
 * Admin Audit Log — immutable record of admin moderation & management actions.
 *
 * Designed for accountability: every admin action that modifies data is logged
 * with the admin's ID, action type, target, and optional metadata.
 *
 * Internal mutations (`internalLogAdminAction`) allow other internal mutations
 * (e.g., refundPurchase) to record audit entries without re-checking auth.
 */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'

type AuditEntry = Doc<'adminAuditLog'>

// ── Helpers ────────────────────────────────────────────────────────────────

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const currentUserId = await auth.getUserId(ctx)
  if (!currentUserId) {
    throw new Error('Not authenticated')
  }

  const currentUser = await ctx.db.get(currentUserId)
  if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
    throw new Error('Admin access required')
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

const actionValidator = v.union(
  v.literal('manual_refund'),
  v.literal('camp_archive'),
  v.literal('camp_unarchive'),
  v.literal('member_ban'),
  v.literal('member_remove'),
  v.literal('report_resolve'),
  v.literal('report_dismiss'),
)

const targetTypeValidator = v.string()
const metadataValidator = v.optional(
  v.object({
    reason: v.optional(v.string()),
    amount: v.optional(v.number()),
    previousStatus: v.optional(v.string()),
    campName: v.optional(v.string()),
    membershipId: v.optional(v.id('campMembers')),
    purchaseId: v.optional(v.id('consumablePurchases')),
    reportId: v.optional(v.id('reports')),
  }),
)

// ── Public Mutation (admin-gated) ──────────────────────────────────────────

/**
 * Record an admin action in the audit log.
 * Callable from the client/admin dashboard UI (requires admin auth).
 */
export const logAdminAction = mutation({
  args: {
    action: actionValidator,
    targetType: targetTypeValidator,
    targetId: v.string(),
    metadata: metadataValidator,
  },
  handler: async (ctx, args) => {
    const currentUserId = await auth.getUserId(ctx)
    if (!currentUserId) {
      throw new Error('Not authenticated')
    }

    const currentUser = await ctx.db.get(currentUserId)
    if (!currentUser?.isAdmin && currentUser?.role !== 'admin') {
      throw new Error('Admin access required')
    }

    await ctx.db.insert('adminAuditLog', {
      adminId: currentUserId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      metadata: args.metadata,
      createdAt: Date.now(),
    })

    return { success: true }
  },
})

// ── Internal Mutation (no auth re-check) ───────────────────────────────────

/**
 * Internal version of logAdminAction — used by other internal mutations
 * (e.g., refundPurchase, banMember) that have already verified admin access.
 * Accepts the adminId directly rather than re-deriving it from auth.
 */
export const internalLogAdminAction = internalMutation({
  args: {
    adminId: v.id('users'),
    action: actionValidator,
    targetType: targetTypeValidator,
    targetId: v.string(),
    metadata: metadataValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('adminAuditLog', {
      adminId: args.adminId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      metadata: args.metadata,
      createdAt: Date.now(),
    })

    return { success: true }
  },
})

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Retrieve audit log entries, filterable by adminId, action, or time window.
 * Reverse chronological (newest first).
 */
export const getAuditLog = query({
  args: {
    adminId: v.optional(v.id('users')),
    action: v.optional(actionValidator),
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)

    const requestedLimit = args.limit ?? 100
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)

    let entries: AuditEntry[] = []

    // Use the most selective index based on filters
    if (args.adminId) {
      const adminId = args.adminId
      const query = ctx.db
        .query('adminAuditLog')
        .withIndex('by_admin', (q) => q.eq('adminId', adminId))
        .order('desc')
      entries = await query.take(limit)
    } else if (args.action) {
      const action = args.action
      const query = ctx.db
        .query('adminAuditLog')
        .withIndex('by_action', (q) => q.eq('action', action))
        .order('desc')
      entries = await query.take(limit)
    } else {
      // No selective index — scan all, sort manually
      const all = await ctx.db.query('adminAuditLog').collect()
      all.sort((a, b) => b.createdAt - a.createdAt)
      entries = all.slice(0, limit)
    }

    // Apply post-filter for days window
    if (args.days) {
      const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000
      entries = entries.filter((e) => e.createdAt >= cutoff)
    }

    // Apply post-filter for action when adminId filter was primary
    if (args.adminId && args.action) {
      entries = entries.filter((e) => e.action === args.action)
    }

    // Re-sort and re-limit after post-filters
    entries.sort((a, b) => b.createdAt - a.createdAt)
    entries = entries.slice(0, limit)

    // Enrich with admin display names
    const enriched = await Promise.all(
      entries.map(async (entry) => {
        const admin = await ctx.db.get(entry.adminId)
        return {
          ...entry,
          adminName: admin?.displayName ?? admin?.name ?? 'Unknown',
        }
      }),
    )

    return enriched
  },
})
