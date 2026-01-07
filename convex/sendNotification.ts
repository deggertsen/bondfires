import { v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { Id } from './_generated/dataModel'

// Send push notification to a user
export const sendToUser = action({
  args: {
    userId: v.id('users'),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Get user's device tokens
    const tokens = await ctx.runQuery(internal.notifications.getTokensForUser, {
      userId: args.userId,
    })
    
    if (tokens.length === 0) {
      console.log(`No device tokens found for user ${args.userId}`)
      return { success: false, reason: 'No device tokens' }
    }
    
    // Send to all user's devices via Expo Push Service
    const messages = tokens.map((t) => ({
      to: t.token,
      sound: 'default' as const,
      title: args.title,
      body: args.body,
      data: args.data ?? {},
    }))
    
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      })
      
      const result = await response.json()
      console.log('Push notification result:', result)
      
      return { success: true, result }
    } catch (error) {
      console.error('Failed to send push notification:', error)
      return { success: false, reason: String(error) }
    }
  },
})

// Notify bondfire owner when someone responds
export const notifyBondfireResponse = action({
  args: {
    bondfireId: v.id('bondfires'),
    responderId: v.id('users'),
  },
  handler: async (ctx, args) => {
    // Get the bondfire to find the owner
    const bondfire = await ctx.runQuery(internal.bondfires.get, {
      bondfireId: args.bondfireId,
    })
    
    if (!bondfire) {
      return { success: false, reason: 'Bondfire not found' }
    }
    
    // Don't notify if the responder is the owner
    if (bondfire.userId === args.responderId) {
      return { success: false, reason: 'Responder is owner' }
    }
    
    // Get responder's name
    const responder = await ctx.runQuery(internal.users.get, {
      userId: args.responderId,
    })
    
    const responderName = responder?.displayName ?? responder?.name ?? 'Someone'
    
    // Send notification to bondfire owner
    return await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: bondfire.userId,
      title: 'New Response! 🔥',
      body: `${responderName} added a video to your bondfire`,
      data: {
        type: 'bondfire_response',
        bondfireId: args.bondfireId,
      },
    })
  },
})

