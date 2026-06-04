/**
 * Admin Audit Log — immutable record of admin moderation & management actions.
 *
 * Designed for accountability: every admin action that modifies data is logged
 * with the admin's ID, action type, target, and optional metadata.
 *
 * Audit entries are written by trusted server-side mutations so the log reflects
 * actions that actually committed.
 */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, query } from './_generated/server'
import { auth } from './auth'

type AuditEntry = Doc<'adminAuditLog'>
type AuditAction = AuditEntry['action']

const DEFAULT_AUDIT_LIMIT = 100
const MAX_AUDIT_LIMIT = 500

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

const targetTypeValidator = v.union(
  v.literal('camp'),
  v.literal('user'),
  v.literal('bondfire'),
  v.literal('purchase'),
  v.literal('report'),
)
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

// ── Internal Mutation (no auth re-check) ───────────────────────────────────

/**
 * Used by other mutations (e.g., refundPurchase, banMember) after they have
 * already authorized the caller and committed the admin action.
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

function normalizeLimit(requestedLimit: number | undefined) {
  return Math.min(Math.max(Math.trunc(requestedLimit ?? DEFAULT_AUDIT_LIMIT), 1), MAX_AUDIT_LIMIT)
}

function getDaysCutoff(days: number | undefined) {
  if (days === undefined) return undefined
  const normalizedDays = Math.max(Math.trunc(days), 1)
  return Date.now() - normalizedDays * 24 * 60 * 60 * 1000
}

function filterByCutoff(entries: AuditEntry[], cutoff: number | undefined) {
  return cutoff === undefined ? entries : entries.filter((entry) => entry.createdAt >= cutoff)
}

async function getAuditEntries(
  ctx: QueryCtx,
  args: { adminId?: AuditEntry['adminId']; action?: AuditAction; days?: number },
  limit: number,
) {
  const cutoff = getDaysCutoff(args.days)
  const indexLimit = cutoff === undefined ? limit : MAX_AUDIT_LIMIT

  if (args.adminId && args.action) {
    const adminId = args.adminId
    const action = args.action
    return filterByCutoff(
      await ctx.db
        .query('adminAuditLog')
        .withIndex('by_admin_action', (q) => q.eq('adminId', adminId).eq('action', action))
        .order('desc')
        .take(indexLimit),
      cutoff,
    ).slice(0, limit)
  }

  if (args.adminId) {
    const adminId = args.adminId
    return filterByCutoff(
      await ctx.db
        .query('adminAuditLog')
        .withIndex('by_admin', (q) => q.eq('adminId', adminId))
        .order('desc')
        .take(indexLimit),
      cutoff,
    ).slice(0, limit)
  }

  if (args.action) {
    const action = args.action
    return filterByCutoff(
      await ctx.db
        .query('adminAuditLog')
        .withIndex('by_action', (q) => q.eq('action', action))
        .order('desc')
        .take(indexLimit),
      cutoff,
    ).slice(0, limit)
  }

  if (cutoff !== undefined) {
    return ctx.db
      .query('adminAuditLog')
      .withIndex('by_created', (q) => q.gte('createdAt', cutoff))
      .order('desc')
      .take(limit)
  }

  return ctx.db.query('adminAuditLog').withIndex('by_created').order('desc').take(limit)
}

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

    const entries = await getAuditEntries(ctx, args, normalizeLimit(args.limit))

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
