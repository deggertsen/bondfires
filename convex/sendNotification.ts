import { v } from 'convex/values'
import { api, internal } from './_generated/api'
import { action, internalAction } from './_generated/server'

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

// Send notification via Expo Push API
async function sendExpoPushNotification(
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
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
            ? ticket.message ?? ticket.details?.error ?? 'Unknown error'
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
    // Get the bondfire to find the creator
    const bondfire = await ctx.runQuery(api.bondfires.get, { id: args.bondfireId })

    if (!bondfire) {
      return { success: false, error: 'Bondfire not found' }
    }

    // Don't notify if user is responding to their own bondfire
    if (bondfire.userId === args.responderId) {
      return { success: true, skipped: true }
    }

    await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: bondfire.userId,
      title: '🔥 New Response!',
      body: `${args.responderName} added a video to your Bondfire`,
      data: {
        type: 'bondfire_response',
        bondfireId: args.bondfireId,
      },
    })

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
