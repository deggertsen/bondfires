import { v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { internal, api } from './_generated/api'

// Firebase Admin SDK types for FCM
interface FCMMessage {
  token: string
  notification?: {
    title: string
    body: string
  }
  data?: Record<string, string>
  android?: {
    priority: 'high' | 'normal'
    notification?: {
      icon?: string
      color?: string
      channelId?: string
    }
  }
  apns?: {
    payload: {
      aps: {
        alert?: {
          title: string
          body: string
        }
        badge?: number
        sound?: string
      }
    }
  }
}

interface FCMResponse {
  successCount: number
  failureCount: number
  results: Array<{
    success: boolean
    messageId?: string
    error?: string
  }>
}

// Send notification via Firebase Cloud Messaging
async function sendFCMNotification(
  serverKey: string,
  message: FCMMessage
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const response = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `key=${serverKey}`,
    },
    body: JSON.stringify({
      to: message.token,
      notification: message.notification,
      data: message.data,
      android: message.android,
      apns: message.apns,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    return { success: false, error: `FCM error: ${response.status} - ${text}` }
  }

  const result = await response.json()
  
  if (result.failure > 0) {
    return { success: false, error: result.results?.[0]?.error ?? 'Unknown FCM error' }
  }

  return { success: true, messageId: result.message_id }
}

// Internal action to send a notification to a specific user
export const sendToUser = internalAction({
  args: {
    userId: v.id('users'),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const serverKey = process.env.FIREBASE_SERVER_KEY
    if (!serverKey) {
      console.error('FIREBASE_SERVER_KEY not configured')
      return { success: false, error: 'Firebase not configured' }
    }

    // Get all device tokens for the user
    const tokens = await ctx.runQuery(api.notifications.getTokensForUser, {
      userId: args.userId,
    })

    if (tokens.length === 0) {
      return { success: false, error: 'No device tokens found for user' }
    }

    const results = await Promise.all(
      tokens.map(async (tokenDoc) => {
        const message: FCMMessage = {
          token: tokenDoc.token,
          notification: {
            title: args.title,
            body: args.body,
          },
          data: args.data ? Object.fromEntries(
            Object.entries(args.data).map(([k, v]) => [k, String(v)])
          ) : undefined,
          android: {
            priority: 'high',
            notification: {
              icon: 'ic_notification',
              color: '#FF6B35',
              channelId: 'bondfires-default',
            },
          },
          apns: {
            payload: {
              aps: {
                alert: {
                  title: args.title,
                  body: args.body,
                },
                badge: 1,
                sound: 'default',
              },
            },
          },
        }

        return sendFCMNotification(serverKey, message)
      })
    )

    const successCount = results.filter((r) => r.success).length
    const failureCount = results.filter((r) => !r.success).length

    return {
      success: successCount > 0,
      successCount,
      failureCount,
      errors: results.filter((r) => !r.success).map((r) => r.error),
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
  handler: async (ctx, args) => {
    // Get the bondfire to find the creator
    const bondfire = await ctx.runQuery(api.bondfires.get, { id: args.bondfireId })
    
    if (!bondfire) {
      return { success: false, error: 'Bondfire not found' }
    }

    // Don't notify if user is responding to their own bondfire
    if (bondfire.userId === args.responderId) {
      return { success: true, skipped: true }
    }

    return await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: bondfire.userId,
      title: '🔥 New Response!',
      body: `${args.responderName} added a video to your Bondfire`,
      data: {
        type: 'bondfire_response',
        bondfireId: args.bondfireId,
      },
    })
  },
})

// Test action to send a notification (for debugging)
export const sendTest = action({
  args: {
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const { auth } = await import('./auth')
    const userId = await auth.getUserId(ctx)
    
    if (!userId) {
      throw new Error('Not authenticated')
    }

    return await ctx.runAction(internal.sendNotification.sendToUser, {
      userId,
      title: args.title,
      body: args.body,
      data: { type: 'test' },
    })
  },
})
