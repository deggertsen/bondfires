import { v } from 'convex/values'
import { api, internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalAction, internalQuery } from './_generated/server'
import { isCampParticipableStatus } from './campLifecycle'

// Expo Push API types
interface ExpoPushMessage {
  to: string | string[]
  title?: string
  body?: string
  data?: Record<string, unknown>
  sound?: 'default' | null
  badge?: number
  channelId?: string
  priority?: 'default' | 'normal' | 'high'
}

interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

interface SendResult {
  success: boolean
  ticketId?: string
  error?: string
}

interface DeviceToken {
  token: string
  platform: 'ios' | 'android'
  tokenType?: 'fcm' | 'expo'
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

function uniqueUserIds(userIds: Array<Id<'users'>>) {
  return [...new Set(userIds)]
}

function getCampNotificationCopy(camp: Doc<'camps'>, creatorName: string) {
  if (camp.crisisBroadcast) {
    return {
      title: 'Signal Fire',
      body: `${creatorName} asked the camp to gather`,
    }
  }

  if (camp.welcomeBroadcast) {
    return {
      title: 'Welcome Fire',
      body: `${creatorName} introduced themselves to the camp`,
    }
  }

  return {
    title: camp.name,
    body: `${creatorName} sparked a new Bondfire`,
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return char
    }
  })
}

// Send notification via Expo Push API
async function sendExpoPushNotification(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Expo Push error: ${response.status} - ${text}`)
  }

  const result = await response.json()
  return result.data as ExpoPushTicket[]
}

// Internal action to send a notification to a specific user
export const sendToUser = internalAction({
  args: {
    userId: v.id('users'),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    successCount?: number
    failureCount?: number
    error?: string
    errors?: (string | undefined)[]
  }> => {
    // Get all device tokens for the user
    const tokens: DeviceToken[] = await ctx.runQuery(api.notifications.getTokensForUser, {
      userId: args.userId,
    })

    if (tokens.length === 0) {
      return { success: false, error: 'No device tokens found for user' }
    }

    // Filter for Expo tokens (tokens starting with "ExponentPushToken")
    const expoTokens = tokens.filter(
      (t) => t.tokenType === 'expo' || t.token.startsWith('ExponentPushToken'),
    )

    if (expoTokens.length === 0) {
      return { success: false, error: 'No Expo push tokens found for user' }
    }

    // Build messages for each token
    const messages: ExpoPushMessage[] = expoTokens.map((tokenDoc) => ({
      to: tokenDoc.token,
      title: args.title,
      body: args.body,
      data: args.data as Record<string, unknown> | undefined,
      sound: 'default',
      priority: 'high',
      channelId: 'bondfires-default',
    }))

    try {
      const tickets = await sendExpoPushNotification(messages)

      const results: SendResult[] = tickets.map((ticket) => ({
        success: ticket.status === 'ok',
        ticketId: ticket.id,
        error:
          ticket.status === 'error'
            ? (ticket.message ?? ticket.details?.error ?? 'Unknown error')
            : undefined,
      }))

      const successCount = results.filter((r) => r.success).length
      const failureCount = results.filter((r) => !r.success).length

      return {
        success: successCount > 0,
        successCount,
        failureCount,
        errors: results.filter((r) => !r.success).map((r) => r.error),
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error sending notification'
      console.error('Error sending Expo push notification:', errorMessage)
      return { success: false, error: errorMessage }
    }
  },
})

export const getLiveNotificationRecipientIds = internalQuery({
  args: {
    creatorId: v.id('users'),
    campId: v.optional(v.id('camps')),
  },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    if (args.campId) {
      const campId = args.campId
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_camp_status', (q) => q.eq('campId', campId).eq('status', 'active'))
        .collect()

      return uniqueUserIds(
        memberships
          .filter((membership) => !membership.muted && membership.userId !== args.creatorId)
          .map((membership) => membership.userId),
      )
    }

    return []
  },
})

export const getCampNotificationDetails = internalQuery({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args): Promise<Doc<'camps'> | null> => {
    const camp = await ctx.db.get(args.campId)
    if (!camp || !isCampParticipableStatus(camp.status)) {
      return null
    }

    return camp
  },
})

export const getCampNotificationRecipientIds = internalQuery({
  args: {
    campId: v.id('camps'),
    creatorId: v.id('users'),
  },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    const memberships = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', args.campId).eq('status', 'active'))
      .collect()

    return uniqueUserIds(
      memberships
        .filter((membership) => !membership.muted && membership.userId !== args.creatorId)
        .map((membership) => membership.userId),
    )
  },
})

export const getResponseNotificationRecipientIds = internalQuery({
  args: {
    bondfireId: v.id('bondfires'),
    responderId: v.id('users'),
  },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      return []
    }

    const participantIds = new Set<Id<'users'>>([bondfire.userId])
    const responseVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()

    for (const responseVideo of responseVideos) {
      participantIds.add(responseVideo.userId)
    }
    participantIds.delete(args.responderId)

    if (!bondfire.campId) {
      return [...participantIds]
    }

    const campId = bondfire.campId
    const memberships = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', campId).eq('status', 'active'))
      .collect()
    const notifiedMemberIds = new Set(
      memberships.filter((membership) => !membership.muted).map((membership) => membership.userId),
    )

    return [...participantIds].filter((userId) => notifiedMemberIds.has(userId))
  },
})

export const notifyCampBondfire = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    creatorId: v.id('users'),
    creatorName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const bondfire = await ctx.runQuery(internal.bondfires.getForNotification, {
      id: args.bondfireId,
    })
    if (!bondfire?.campId) {
      return { success: true, skipped: true }
    }

    const camp = await ctx.runQuery(internal.sendNotification.getCampNotificationDetails, {
      campId: bondfire.campId,
    })
    if (!camp) {
      return { success: false, error: 'Camp not found' }
    }

    const recipientIds: Array<Id<'users'>> = await ctx.runQuery(
      internal.sendNotification.getCampNotificationRecipientIds,
      {
        campId: bondfire.campId,
        creatorId: args.creatorId,
      },
    )

    if (recipientIds.length === 0) {
      return { success: true, skipped: true }
    }

    const copy = getCampNotificationCopy(camp, args.creatorName)
    await Promise.all(
      recipientIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: copy.title,
          body: copy.body,
          data: {
            type: camp.crisisBroadcast
              ? 'camp_crisis'
              : camp.welcomeBroadcast
                ? 'camp_welcome'
                : 'camp_bondfire',
            bondfireId: args.bondfireId,
            campId: bondfire.campId,
          },
        }),
      ),
    )

    return { success: true }
  },
})

// Send notification when someone responds to a bondfire
export const notifyBondfireResponse = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    responderId: v.id('users'),
    responderName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const bondfire = await ctx.runQuery(internal.bondfires.getForNotification, {
      id: args.bondfireId,
    })

    if (!bondfire) {
      return { success: false, error: 'Bondfire not found' }
    }

    const recipientIds: Array<Id<'users'>> = await ctx.runQuery(
      internal.sendNotification.getResponseNotificationRecipientIds,
      {
        bondfireId: args.bondfireId,
        responderId: args.responderId,
      },
    )

    if (recipientIds.length === 0) {
      return { success: true, skipped: true }
    }

    await Promise.all(
      recipientIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: 'New response',
          body: `${args.responderName} added a video to a Bondfire you're in`,
          data: {
            type: 'bondfire_response',
            bondfireId: args.bondfireId,
            campId: bondfire.campId,
          },
        }),
      ),
    )

    return { success: true }
  },
})

// Send notification when a creator's live bondfire becomes watchable.
export const notifyBondfireLive = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    creatorId: v.id('users'),
    creatorName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const bondfire = await ctx.runQuery(internal.bondfires.getForNotification, {
      id: args.bondfireId,
    })

    if (!bondfire) {
      return { success: false, error: 'Bondfire not found' }
    }

    const recipientIds: Array<Id<'users'>> = await ctx.runQuery(
      internal.sendNotification.getLiveNotificationRecipientIds,
      {
        creatorId: args.creatorId,
        campId: bondfire.campId,
      },
    )

    if (recipientIds.length === 0) {
      return { success: true, skipped: true }
    }

    await Promise.all(
      recipientIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: 'Live now',
          body: `${args.creatorName} is live right now`,
          data: {
            type: 'bondfire_live',
            bondfireId: args.bondfireId,
          },
        }),
      ),
    )

    return { success: true }
  },
})

// Test action to send a notification (for debugging)
export const sendTest = action({
  args: {
    title: v.string(),
    body: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    successCount?: number
    failureCount?: number
    error?: string
    errors?: (string | undefined)[]
  }> => {
    const { auth } = await import('./auth')
    const userId = await auth.getUserId(ctx)

    if (!userId) {
      throw new Error('Not authenticated')
    }

    const result = await ctx.runAction(internal.sendNotification.sendToUser, {
      userId,
      title: args.title,
      body: args.body,
      data: { type: 'test' },
    })

    return result
  },
})

// ── Access Request Notifications ──

/** Push notification to camp owner when someone requests access. */
export const notifyAccessRequest = internalAction({
  args: {
    membershipId: v.id('campMembers'),
    campId: v.id('camps'),
    requesterId: v.id('users'),
    requesterName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const camp = await ctx.runQuery(internal.sendNotification.getCampNotificationDetails, {
      campId: args.campId,
    })
    if (!camp || !camp.ownerId) {
      return { success: false, error: 'Camp or owner not found' }
    }

    const result = await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: camp.ownerId,
      title: 'New access request',
      body: `${args.requesterName} wants to join ${camp.name}`,
      data: {
        type: 'camp_access_request',
        campId: args.campId,
        membershipId: args.membershipId,
      },
    })

    return result
  },
})

/** Email notification to camp owner when someone requests access. */
export const emailAccessRequest = internalAction({
  args: {
    membershipId: v.id('campMembers'),
    campId: v.id('camps'),
    requesterId: v.id('users'),
    requesterName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    error?: string
  }> => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      return { success: true }
    }

    const camp = await ctx.runQuery(internal.sendNotification.getCampNotificationDetails, {
      campId: args.campId,
    })
    if (!camp || !camp.ownerId) {
      return { success: false, error: 'Camp or owner not found' }
    }

    // Get owner email from users table
    const owner = await ctx.runQuery(internal.sendNotification.getUserEmail, {
      userId: camp.ownerId,
    })
    if (!owner?.email) {
      return { success: true, error: 'Owner email not found' }
    }

    const campName = camp.name
    const safeCampName = escapeHtml(campName)
    const safeRequesterName = escapeHtml(args.requesterName)

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Bondfires <support@bondfires.org>',
          to: owner.email,
          subject: `${args.requesterName} wants to join ${campName}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #F59E0B; margin-bottom: 8px;">New Access Request</h1>
              <p style="font-size: 16px; color: #333; line-height: 1.5;">
                <strong>${safeRequesterName}</strong> has requested to join <strong>${safeCampName}</strong>.
              </p>
              <div style="margin-top: 24px;">
                <a href="https://bondfires.org/camp/${args.campId}"
                   style="display: inline-block; background: #D97736; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                  Review Request
                </a>
              </div>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <p style="font-size: 12px; color: #999;">This email was sent automatically by Bondfires because you are the camp owner.</p>
            </div>
          `,
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Failed to send access request email:', error)
        return { success: false, error }
      }

      return { success: true }
    } catch (error) {
      console.error('Error sending access request email:', error)
      return { success: false, error: String(error) }
    }
  },
})

/** Internal query to get a user's email. */
export const getUserEmail = internalQuery({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (!user) return null
    return { email: user.email }
  },
})
