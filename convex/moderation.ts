import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

const MAX_NOTE_LENGTH = 1_000

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const adminId = await auth.getUserId(ctx)
  if (!adminId) throwUserError('Not authenticated')
  const admin = await ctx.db.get(adminId)
  if (!admin?.isAdmin && admin?.role !== 'admin') throwUserError('Admin access required')
  return adminId
}

function cleanNote(note: string | undefined, required = false) {
  const value = note?.trim() ?? ''
  if (required && value.length < 10) throwUserError('Provide a reason of at least 10 characters')
  if (value.length > MAX_NOTE_LENGTH) throwUserError('Reason is too long')
  return value || undefined
}

function assertModerationTransition(
  current: 'pending_review' | 'approved' | 'removed' | undefined,
  action: 'approve' | 'remove' | 'restore',
) {
  if (action === 'approve' && current !== 'pending_review') {
    throwUserError('Only content awaiting review can be approved')
  }
  if (action === 'restore' && current !== 'removed') {
    throwUserError('Only removed content can be restored')
  }
  if (action === 'remove' && current === 'removed') {
    throwUserError('Content is already removed')
  }
}

async function writeAudit(
  ctx: MutationCtx,
  args: {
    adminId: Id<'users'>
    subjectUserId: Id<'users'>
    action:
      | 'report_resolve'
      | 'report_dismiss'
      | 'content_approve'
      | 'content_remove'
      | 'content_restore'
      | 'user_suspend'
      | 'user_reactivate'
    targetType: 'report' | 'bondfire' | 'response' | 'user'
    targetId: string
    reason?: string
    reportId?: Id<'reports'>
    previousStatus?: string
  },
) {
  await ctx.db.insert('adminAuditLog', {
    adminId: args.adminId,
    subjectUserId: args.subjectUserId,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    metadata: {
      reason: args.reason,
      previousStatus: args.previousStatus,
      reportId: args.reportId,
    },
    createdAt: Date.now(),
  })
}

export const getQueue = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx)
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100)
    const [
      reports,
      readyBondfires,
      liveBondfires,
      readyResponses,
      liveResponses,
      removedBondfires,
      removedResponses,
      suspendedUsers,
    ] = await Promise.all([
      ctx.db
        .query('reports')
        .withIndex('by_status', (q) => q.eq('status', 'pending'))
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfires')
        .withIndex('by_moderation_video_status', (q) =>
          q.eq('moderationStatus', 'pending_review').eq('videoStatus', 'ready'),
        )
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfires')
        .withIndex('by_moderation_video_status', (q) =>
          q.eq('moderationStatus', 'pending_review').eq('videoStatus', 'live'),
        )
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfireVideos')
        .withIndex('by_moderation_video_status', (q) =>
          q.eq('moderationStatus', 'pending_review').eq('videoStatus', 'ready'),
        )
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfireVideos')
        .withIndex('by_moderation_video_status', (q) =>
          q.eq('moderationStatus', 'pending_review').eq('videoStatus', 'live'),
        )
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfires')
        .withIndex('by_moderation_status', (q) => q.eq('moderationStatus', 'removed'))
        .order('desc')
        .take(limit),
      ctx.db
        .query('bondfireVideos')
        .withIndex('by_moderation_status', (q) => q.eq('moderationStatus', 'removed'))
        .order('desc')
        .take(limit),
      ctx.db
        .query('users')
        .withIndex('by_moderation_status', (q) => q.eq('moderationStatus', 'suspended'))
        .order('desc')
        .take(limit),
    ])

    const bondfires = [...readyBondfires, ...liveBondfires]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
    const responses = [...readyResponses, ...liveResponses]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)

    const enrichedReports = await Promise.all(
      reports.map(async (report) => {
        const [reporter, target, response] = await Promise.all([
          ctx.db.get(report.reporterUserId),
          ctx.db.get(report.videoOwnerId),
          report.bondfireVideoId ? ctx.db.get(report.bondfireVideoId) : null,
        ])
        return {
          ...report,
          reporterName: reporter?.displayName ?? reporter?.name ?? 'Unknown',
          targetName: target?.displayName ?? target?.name ?? 'Unknown',
          reviewBondfireId: report.bondfireId ?? response?.bondfireId,
        }
      }),
    )

    return {
      reports: enrichedReports,
      content: [
        ...bondfires.map((row) => ({
          targetType: 'bondfire' as const,
          targetId: row._id,
          bondfireId: row._id,
          ownerId: row.userId,
          creatorName: row.creatorName,
          title: row.title,
          createdAt: row.createdAt,
        })),
        ...responses.map((row) => ({
          targetType: 'response' as const,
          targetId: row._id,
          bondfireId: row.bondfireId,
          ownerId: row.userId,
          creatorName: row.creatorName,
          createdAt: row.createdAt,
        })),
      ]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
      removedContent: [
        ...removedBondfires.map((row) => ({
          targetType: 'bondfire' as const,
          targetId: row._id,
          creatorName: row.creatorName,
          title: row.title,
          moderatedAt: row.moderatedAt ?? row.updatedAt,
        })),
        ...removedResponses.map((row) => ({
          targetType: 'response' as const,
          targetId: row._id,
          creatorName: row.creatorName,
          moderatedAt: row.moderatedAt ?? row.createdAt,
        })),
      ]
        .sort((a, b) => b.moderatedAt - a.moderatedAt)
        .slice(0, limit),
      suspendedUsers: suspendedUsers.map((user) => ({
        userId: user._id,
        displayName: user.displayName ?? user.name ?? 'Unknown',
        reason: user.suspensionReason,
        suspendedAt: user.suspendedAt,
      })),
    }
  },
})

export const moderateContent = mutation({
  args: {
    targetType: v.union(v.literal('bondfire'), v.literal('response')),
    targetId: v.string(),
    action: v.union(v.literal('approve'), v.literal('remove'), v.literal('restore')),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx)
    const reason = cleanNote(args.reason, args.action === 'remove')
    const now = Date.now()
    const nextStatus = args.action === 'remove' ? 'removed' : 'approved'

    if (args.targetType === 'bondfire') {
      const id = ctx.db.normalizeId('bondfires', args.targetId)
      if (!id) throwUserError('Content not found')
      const record = await ctx.db.get(id)
      if (!record) throwUserError('Content not found')
      assertModerationTransition(record.moderationStatus, args.action)
      await ctx.db.patch(id, {
        moderationStatus: nextStatus,
        moderationReason: reason,
        moderatedAt: now,
        moderatedBy: adminId,
      })
      await writeAudit(ctx, {
        adminId,
        subjectUserId: record.userId,
        action: `content_${args.action}`,
        targetType: 'bondfire',
        targetId: id,
        reason,
        previousStatus: record.moderationStatus,
      })
      if (args.action === 'approve' && record.moderationStatus === 'pending_review') {
        await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
          bondfireId: id,
          creatorId: record.userId,
          creatorName: record.creatorName ?? 'Someone',
        })
      }
    } else {
      const id = ctx.db.normalizeId('bondfireVideos', args.targetId)
      if (!id) throwUserError('Content not found')
      const record = await ctx.db.get(id)
      if (!record) throwUserError('Content not found')
      assertModerationTransition(record.moderationStatus, args.action)
      await ctx.db.patch(id, {
        moderationStatus: nextStatus,
        moderationReason: reason,
        moderatedAt: now,
        moderatedBy: adminId,
      })
      await writeAudit(ctx, {
        adminId,
        subjectUserId: record.userId,
        action: `content_${args.action}`,
        targetType: 'response',
        targetId: id,
        reason,
        previousStatus: record.moderationStatus,
      })
      if (args.action === 'approve' && record.moderationStatus === 'pending_review') {
        await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
          bondfireId: record.bondfireId,
          responderId: record.userId,
          responderName: record.creatorName ?? 'Someone',
          bondfireVideoId: id,
        })
      }
    }
    return { status: nextStatus }
  },
})

export const setUserStatus = mutation({
  args: {
    userId: v.id('users'),
    status: v.union(v.literal('active'), v.literal('suspended')),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx)
    if (adminId === args.userId) throwUserError('You cannot suspend your own admin account')
    const user = await ctx.db.get(args.userId)
    if (!user) throwUserError('User not found')
    const reason = cleanNote(args.reason, args.status === 'suspended')
    await ctx.db.patch(args.userId, {
      moderationStatus: args.status,
      suspendedAt: args.status === 'suspended' ? Date.now() : undefined,
      suspensionReason: args.status === 'suspended' ? reason : undefined,
      updatedAt: Date.now(),
    })
    await writeAudit(ctx, {
      adminId,
      subjectUserId: args.userId,
      action: args.status === 'suspended' ? 'user_suspend' : 'user_reactivate',
      targetType: 'user',
      targetId: args.userId,
      reason,
      previousStatus: user.moderationStatus ?? 'active',
    })
    return { status: args.status }
  },
})

export const reviewReport = mutation({
  args: {
    reportId: v.id('reports'),
    decision: v.union(v.literal('resolve'), v.literal('dismiss')),
    note: v.optional(v.string()),
    removeContent: v.optional(v.boolean()),
    suspendUser: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx)
    const report = await ctx.db.get(args.reportId)
    if (!report) throwUserError('Report not found')
    if (report.status === 'resolved' || report.status === 'dismissed') {
      throwUserError('This report has already been closed')
    }
    const note = cleanNote(args.note, args.decision === 'resolve')
    const resolutionAction: string[] = []

    if (args.decision === 'resolve' && args.removeContent) {
      if (report.bondfireId) {
        const target = await ctx.db.get(report.bondfireId)
        if (!target) throwUserError('Reported content no longer exists')
        await ctx.db.patch(report.bondfireId, {
          moderationStatus: 'removed',
          moderationReason: note,
          moderatedAt: Date.now(),
          moderatedBy: adminId,
        })
        resolutionAction.push('content_removed')
        await writeAudit(ctx, {
          adminId,
          subjectUserId: report.videoOwnerId,
          action: 'content_remove',
          targetType: 'bondfire',
          targetId: report.bondfireId,
          reason: note,
          reportId: args.reportId,
          previousStatus: target.moderationStatus,
        })
      } else if (report.bondfireVideoId) {
        const target = await ctx.db.get(report.bondfireVideoId)
        if (!target) throwUserError('Reported content no longer exists')
        await ctx.db.patch(report.bondfireVideoId, {
          moderationStatus: 'removed',
          moderationReason: note,
          moderatedAt: Date.now(),
          moderatedBy: adminId,
        })
        resolutionAction.push('content_removed')
        await writeAudit(ctx, {
          adminId,
          subjectUserId: report.videoOwnerId,
          action: 'content_remove',
          targetType: 'response',
          targetId: report.bondfireVideoId,
          reason: note,
          reportId: args.reportId,
          previousStatus: target.moderationStatus,
        })
      }
    }
    if (args.decision === 'resolve' && args.suspendUser) {
      if (report.videoOwnerId === adminId) {
        throwUserError('You cannot suspend your own admin account')
      }
      const target = await ctx.db.get(report.videoOwnerId)
      if (!target) throwUserError('Reported user no longer exists')
      await ctx.db.patch(report.videoOwnerId, {
        moderationStatus: 'suspended',
        suspendedAt: Date.now(),
        suspensionReason: note,
        updatedAt: Date.now(),
      })
      resolutionAction.push('user_suspended')
      await writeAudit(ctx, {
        adminId,
        subjectUserId: report.videoOwnerId,
        action: 'user_suspend',
        targetType: 'user',
        targetId: report.videoOwnerId,
        reason: note,
        reportId: args.reportId,
        previousStatus: target.moderationStatus ?? 'active',
      })
    }

    const nextStatus = args.decision === 'resolve' ? 'resolved' : 'dismissed'
    await ctx.db.patch(args.reportId, {
      status: nextStatus,
      reviewedAt: Date.now(),
      reviewedBy: adminId,
      moderatorNote: note,
      resolutionAction: resolutionAction.join(',') || 'none',
    })
    await writeAudit(ctx, {
      adminId,
      subjectUserId: report.videoOwnerId,
      action: args.decision === 'resolve' ? 'report_resolve' : 'report_dismiss',
      targetType: 'report',
      targetId: args.reportId,
      reason: note,
      reportId: args.reportId,
      previousStatus: report.status,
    })
    return { status: nextStatus, actions: resolutionAction }
  },
})
