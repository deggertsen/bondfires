import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
} from './bondfireVisibility'
import {
  hasReachedDailyReportLimit,
  MAX_REPORTS_PER_DAY,
  normalizeReportComments,
  validateReportTargetCount,
} from './lib/reportPolicy'

const DAY_MS = 24 * 60 * 60 * 1000

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[char] ?? char
  })
}

// Category and subcategory validators
const categoryValidator = v.union(
  v.literal('camp_guidelines'),
  v.literal('community_guidelines'),
  v.literal('terms_of_service'),
  v.literal('privacy_policy'),
)

const subCategoryValidator = v.optional(
  v.union(
    v.literal('harassment_or_abuse'),
    v.literal('discrimination'),
    v.literal('harmful_content'),
    v.literal('spam_or_solicitation'),
    v.literal('misinformation'),
    v.literal('impersonation'),
    v.literal('pornographic_content'),
    v.literal('child_safety_concern'),
    v.literal('other'),
  ),
)

// Category labels for email display
const categoryLabels: Record<string, string> = {
  camp_guidelines: 'Camp Guidelines Violation',
  community_guidelines: 'Community Guidelines Violation',
  terms_of_service: 'Terms of Service Violation',
  privacy_policy: 'Privacy Policy Violation',
}

// Sub-category labels for email display
const subCategoryLabels: Record<string, string> = {
  harassment_or_abuse: 'Harassment or Abuse',
  discrimination: 'Discrimination',
  harmful_content: 'Harmful Content',
  spam_or_solicitation: 'Spam or Solicitation',
  misinformation: 'Misinformation',
  impersonation: 'Impersonation',
  pornographic_content: 'Pornographic Content',
  child_safety_concern: 'Child Safety Concern',
  other: 'Other',
}

// Submit a content or user report. Target ownership is always derived from
// stored records; clients cannot attribute a report to an arbitrary user.
export const submit = mutation({
  args: {
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
    reportedUserId: v.optional(v.id('users')),
    // Accepted only for backwards compatibility with already-shipped clients;
    // ignored in favor of the server-derived target owner.
    videoOwnerId: v.optional(v.id('users')),
    category: categoryValidator,
    subCategory: subCategoryValidator,
    comments: v.string(),
  },
  handler: async (ctx, args) => {
    const reporterUserId = await auth.getUserId(ctx)
    if (!reporterUserId) {
      throw new Error('Not authenticated')
    }

    validateReportTargetCount([args.bondfireId, args.bondfireVideoId, args.reportedUserId])
    const comments = normalizeReportComments(args.comments)

    const recentReports = await ctx.db
      .query('reports')
      .withIndex('by_reporter', (q) =>
        q.eq('reporterUserId', reporterUserId).gte('createdAt', Date.now() - DAY_MS),
      )
      .take(MAX_REPORTS_PER_DAY)
    if (hasReachedDailyReportLimit(recentReports.length)) {
      throw new Error('You have reached the daily report limit. Contact safety@bondfires.org.')
    }

    let targetOwnerId: typeof reporterUserId
    let targetVideoId: string
    let videoType: 'bondfire' | 'response' | 'user'
    if (args.bondfireId) {
      const bondfire = await ctx.db.get(args.bondfireId)
      if (!bondfire) throw new Error('Content not found')
      const viewer = await buildViewerVisibilityContext(ctx, reporterUserId)
      if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
        throw new Error('Content not found')
      }
      targetOwnerId = bondfire.userId
      targetVideoId = bondfire._id
      videoType = 'bondfire'
    } else if (args.bondfireVideoId) {
      const response = await ctx.db.get(args.bondfireVideoId)
      if (!response) throw new Error('Content not found')
      const bondfire = await ctx.db.get(response.bondfireId)
      if (!bondfire) throw new Error('Content not found')
      const viewer = await buildViewerVisibilityContext(ctx, reporterUserId)
      const responseVisible =
        (await isBondfireVisibleToViewer(ctx, bondfire, viewer)) &&
        (await isUserContentVisibleToViewer(ctx, response.userId, viewer)) &&
        response.moderationStatus !== 'removed' &&
        (response.moderationStatus !== 'pending_review' ||
          response.userId === reporterUserId ||
          viewer.isAdmin)
      if (!responseVisible) {
        throw new Error('Content not found')
      }
      targetOwnerId = response.userId
      targetVideoId = response._id
      videoType = 'response'
    } else {
      const target = args.reportedUserId ? await ctx.db.get(args.reportedUserId) : null
      if (!target || !args.reportedUserId) throw new Error('User not found')
      targetOwnerId = args.reportedUserId
      targetVideoId = args.reportedUserId
      videoType = 'user'
    }

    if (targetOwnerId === reporterUserId) throw new Error('You cannot report yourself')

    // Prevent duplicate reports from same user on same video
    const existingReport = args.bondfireId
      ? await ctx.db
          .query('reports')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
          .filter((q) => q.eq(q.field('reporterUserId'), reporterUserId))
          .first()
      : args.bondfireVideoId
        ? await ctx.db
            .query('reports')
            .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', args.bondfireVideoId))
            .filter((q) => q.eq(q.field('reporterUserId'), reporterUserId))
            .first()
        : await ctx.db
            .query('reports')
            .withIndex('by_reported_user', (q) => q.eq('reportedUserId', args.reportedUserId))
            .filter((q) => q.eq(q.field('reporterUserId'), reporterUserId))
            .first()

    if (existingReport) {
      throw new Error('You have already reported this target')
    }

    // Get reporter info for email
    const reporter = await ctx.db.get(reporterUserId)
    const videoOwner = await ctx.db.get(targetOwnerId)

    const reportId = await ctx.db.insert('reports', {
      reporterUserId,
      bondfireId: args.bondfireId,
      bondfireVideoId: args.bondfireVideoId,
      reportedUserId: args.reportedUserId,
      videoOwnerId: targetOwnerId,
      category: args.category,
      subCategory: args.subCategory,
      comments,
      status: 'pending',
      createdAt: Date.now(),
    })

    // Trigger email notification (async, non-blocking)
    await ctx.scheduler.runAfter(0, internal.reports.sendReportNotificationEmail, {
      reportId,
      videoType,
      videoId: targetVideoId,
      category: args.category,
      subCategory: args.subCategory,
      comments,
      reporterEmail: reporter?.email,
      reporterName: reporter?.displayName || reporter?.name,
      videoOwnerEmail: videoOwner?.email,
      videoOwnerName: videoOwner?.displayName || videoOwner?.name,
    })

    return reportId
  },
})

// Check if user has already reported a bondfire
export const hasReportedBondfire = query({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return false
    }

    const existingReport = await ctx.db
      .query('reports')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .filter((q) => q.eq(q.field('reporterUserId'), userId))
      .first()

    return !!existingReport
  },
})

// Check if user has already reported a bondfire video (response)
export const hasReportedBondfireVideo = query({
  args: {
    bondfireVideoId: v.id('bondfireVideos'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return false
    }

    const existingReport = await ctx.db
      .query('reports')
      .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', args.bondfireVideoId))
      .filter((q) => q.eq(q.field('reporterUserId'), userId))
      .first()

    return !!existingReport
  },
})

// Internal action to send email notification to safety team
export const sendReportNotificationEmail = internalAction({
  args: {
    reportId: v.id('reports'),
    videoType: v.union(v.literal('bondfire'), v.literal('response'), v.literal('user')),
    videoId: v.string(), // String here is fine - it's just for email display
    category: categoryValidator,
    subCategory: subCategoryValidator,
    comments: v.string(),
    reporterEmail: v.optional(v.string()),
    reporterName: v.optional(v.string()),
    videoOwnerEmail: v.optional(v.string()),
    videoOwnerName: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      return { success: true }
    }

    const categoryLabel = categoryLabels[args.category] || args.category
    const subCategoryLabel = args.subCategory
      ? subCategoryLabels[args.subCategory] || args.subCategory
      : null

    // Determine priority based on category
    const isHighPriority = args.subCategory === 'child_safety_concern'
    const priorityBadge = isHighPriority
      ? '<span style="background: #EF4444; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">HIGH PRIORITY</span>'
      : ''
    const reporterName = escapeHtml(args.reporterName || 'Unknown')
    const reporterEmail = escapeHtml(args.reporterEmail || 'Unknown')
    const ownerName = escapeHtml(args.videoOwnerName || 'Unknown')
    const ownerEmail = escapeHtml(args.videoOwnerEmail || 'Unknown')
    const comments = escapeHtml(args.comments)

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Bondfires <support@bondfires.org>',
          to: 'safety@bondfires.org',
          subject: `${isHighPriority ? '[HIGH PRIORITY] ' : ''}[Safety Report] ${categoryLabel} - ${args.videoType} ${args.videoId}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #EF4444; margin-bottom: 8px;">Safety Report Received</h1>
              ${priorityBadge}

              <h2 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Report Details</h2>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Report ID:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-family: monospace;">${args.reportId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Target Type:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.videoType}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Target ID:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-family: monospace;">${args.videoId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Category:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${categoryLabel}</td>
                </tr>
                ${
                  subCategoryLabel
                    ? `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Sub-category:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${subCategoryLabel}</td>
                </tr>
                `
                    : ''
                }
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Reporter Information</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Name:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${reporterName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${reporterEmail}</td>
                </tr>
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Reported User Information</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Name:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${ownerName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${ownerEmail}</td>
                </tr>
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Reporter Comments</h3>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; white-space: pre-wrap;">${comments}</div>

              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <p style="font-size: 12px; color: #999;">This email was sent automatically by the Bondfires safety system.</p>
            </div>
          `,
          text: `Safety Report Received\n\nReport ID: ${args.reportId}\nTarget Type: ${args.videoType}\nTarget ID: ${args.videoId}\nCategory: ${categoryLabel}${subCategoryLabel ? `\nSub-category: ${subCategoryLabel}` : ''}\n\nReporter: ${args.reporterName || 'Unknown'} (${args.reporterEmail || 'Unknown'})\nReported User: ${args.videoOwnerName || 'Unknown'} (${args.videoOwnerEmail || 'Unknown'})\n\nComments:\n${args.comments}`,
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Failed to send report email:', error)
        return { success: false, error }
      }

      return { success: true }
    } catch (error) {
      console.error('Error sending report email:', error)
      return { success: false, error: String(error) }
    }
  },
})
