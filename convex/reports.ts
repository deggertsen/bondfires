import { v } from 'convex/values'
import { internalAction, mutation, query } from './_generated/server'
import { auth } from './auth'
import { internal } from './_generated/api'

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

// Submit a new video report
export const submit = mutation({
  args: {
    // Exactly one of these must be provided
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
    videoOwnerId: v.id('users'),
    category: categoryValidator,
    subCategory: subCategoryValidator,
    comments: v.string(),
  },
  handler: async (ctx, args) => {
    const reporterUserId = await auth.getUserId(ctx)
    if (!reporterUserId) {
      throw new Error('Not authenticated')
    }

    // Validate exactly one video ID is provided
    if ((!args.bondfireId && !args.bondfireVideoId) || (args.bondfireId && args.bondfireVideoId)) {
      throw new Error('Exactly one of bondfireId or bondfireVideoId must be provided')
    }

    // Validate comments minimum length
    if (args.comments.trim().length < 30) {
      throw new Error('Comments must be at least 30 characters')
    }

    // Prevent duplicate reports from same user on same video
    let existingReport
    if (args.bondfireId) {
      existingReport = await ctx.db
        .query('reports')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
        .filter((q) => q.eq(q.field('reporterUserId'), reporterUserId))
        .first()
    } else {
      existingReport = await ctx.db
        .query('reports')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', args.bondfireVideoId))
        .filter((q) => q.eq(q.field('reporterUserId'), reporterUserId))
        .first()
    }

    if (existingReport) {
      throw new Error('You have already reported this video')
    }

    // Get reporter info for email
    const reporter = await ctx.db.get(reporterUserId)
    const videoOwner = await ctx.db.get(args.videoOwnerId)

    const reportId = await ctx.db.insert('reports', {
      reporterUserId,
      bondfireId: args.bondfireId,
      bondfireVideoId: args.bondfireVideoId,
      videoOwnerId: args.videoOwnerId,
      category: args.category,
      subCategory: args.subCategory,
      comments: args.comments.trim(),
      status: 'pending',
      createdAt: Date.now(),
    })

    // Determine video type and ID for email
    const videoType = args.bondfireId ? 'bondfire' : 'response'
    const videoId = args.bondfireId || args.bondfireVideoId

    // Trigger email notification (async, non-blocking)
    await ctx.scheduler.runAfter(0, internal.reports.sendReportNotificationEmail, {
      reportId,
      videoType,
      videoId: videoId!,
      category: args.category,
      subCategory: args.subCategory,
      comments: args.comments.trim(),
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
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
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
      console.log('RESEND_API_KEY not set, skipping report email')
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

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Bondfires <noreply@bondfires.org>',
          to: 'safety@bondfires.org',
          subject: `${isHighPriority ? '[HIGH PRIORITY] ' : ''}[Video Report] ${categoryLabel} - ${args.videoType} ${args.videoId}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #EF4444; margin-bottom: 8px;">Video Report Received</h1>
              ${priorityBadge}

              <h2 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Report Details</h2>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Report ID:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-family: monospace;">${args.reportId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Video Type:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.videoType}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Video ID:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-family: monospace;">${args.videoId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Category:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${categoryLabel}</td>
                </tr>
                ${subCategoryLabel ? `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Sub-category:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${subCategoryLabel}</td>
                </tr>
                ` : ''}
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Reporter Information</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Name:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.reporterName || 'Unknown'}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.reporterEmail || 'Unknown'}</td>
                </tr>
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Video Owner Information</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 140px;">Name:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.videoOwnerName || 'Unknown'}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${args.videoOwnerEmail || 'Unknown'}</td>
                </tr>
              </table>

              <h3 style="color: #333; margin-top: 24px; margin-bottom: 12px;">Reporter Comments</h3>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; white-space: pre-wrap;">${args.comments}</div>

              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <p style="font-size: 12px; color: #999;">This email was sent automatically by the Bondfires safety system.</p>
            </div>
          `,
          text: `Video Report Received\n\nReport ID: ${args.reportId}\nVideo Type: ${args.videoType}\nVideo ID: ${args.videoId}\nCategory: ${categoryLabel}${subCategoryLabel ? `\nSub-category: ${subCategoryLabel}` : ''}\n\nReporter: ${args.reporterName || 'Unknown'} (${args.reporterEmail || 'Unknown'})\nVideo Owner: ${args.videoOwnerName || 'Unknown'} (${args.videoOwnerEmail || 'Unknown'})\n\nComments:\n${args.comments}`,
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
