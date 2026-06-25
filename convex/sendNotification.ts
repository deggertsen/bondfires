import { v } from 'convex/values'
import { api, internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalAction, internalMutation, internalQuery } from './_generated/server'
import { isCampParticipableStatus } from './campLifecycle'
import { resolveNotificationPrefs } from './notifications'

// Max one response push per bondfire per recipient per hour.
const RESPONSE_THROTTLE_MS = 60 * 60 * 1000

// ── Notification categories (server-side preference enforcement) ──
// Every push is tagged with a category; sendToUser drops it when the
// recipient disabled that category. 'account' (camp lifecycle) and the
// debug test path always send.
export const notificationCategory = v.union(
  v.literal('recording'), // camp bondfires + live (new activity)
  v.literal('responses'), // responses to bondfires you've participated in
  v.literal('reminder'), // daily digest + 72h nudge
  v.literal('membership'), // invites, access requests/approvals
  v.literal('hearth'), // Hearth bondfires, responses, joins
  v.literal('account'), // lifecycle warnings — always delivered
)
export type NotificationCategory =
  | 'recording'
  | 'responses'
  | 'reminder'
  | 'membership'
  | 'hearth'
  | 'account'

/** Whether the user's preferences allow a push in this category. */
export const isCategoryEnabledForUser = internalQuery({
  args: {
    userId: v.id('users'),
    category: notificationCategory,
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (args.category === 'account') return true
    const user = await ctx.db.get(args.userId)
    const prefs = resolveNotificationPrefs(user?.notificationPrefs)
    switch (args.category) {
      case 'recording':
        return prefs.recordingActivity
      case 'responses':
        return prefs.responses
      case 'reminder':
        return prefs.reminders
      case 'membership':
        return prefs.invitesAndMembership
      case 'hearth':
        return prefs.hearth
      default:
        return true
    }
  },
})

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

/**
 * Atomically claim notification deliveries for a set of recipients.
 *
 * A recipient is claimable when (a) they have never been notified about
 * this video (`videoKey` dedupe — live-start suppresses publish-time
 * sends), and (b) if `throttleMs` is given, their most recent delivery in
 * this thread (`threadKey`) is older than the throttle window.
 *
 * Claiming inserts the delivery row inside one mutation, so concurrent
 * notify paths (live-start webhook vs. publish) cannot double-send.
 * Returns only the userIds that were claimed and should receive a push.
 */
export const claimDeliveries = internalMutation({
  args: {
    userIds: v.array(v.id('users')),
    videoKey: v.string(),
    threadKey: v.string(),
    throttleMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    const now = Date.now()
    const claimed: Array<Id<'users'>> = []

    for (const userId of uniqueUserIds(args.userIds)) {
      const alreadyNotified = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_video_user', (q) => q.eq('videoKey', args.videoKey).eq('userId', userId))
        .first()
      if (alreadyNotified) continue

      if (args.throttleMs !== undefined) {
        const latestInThread = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_user_thread', (q) =>
            q.eq('userId', userId).eq('threadKey', args.threadKey),
          )
          .order('desc')
          .first()
        if (latestInThread && now - latestInThread.sentAt < args.throttleMs) continue
      }

      await ctx.db.insert('notificationDeliveries', {
        userId,
        videoKey: args.videoKey,
        threadKey: args.threadKey,
        sentAt: now,
      })
      claimed.push(userId)
    }

    return claimed
  },
})

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
    // Preference category. Omitted = always send (debug/test paths).
    category: v.optional(notificationCategory),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    successCount?: number
    failureCount?: number
    error?: string
    errors?: (string | undefined)[]
  }> => {
    // Server-side preference enforcement — single choke point for all push.
    if (args.category) {
      const enabled: boolean = await ctx.runQuery(
        internal.sendNotification.isCategoryEnabledForUser,
        { userId: args.userId, category: args.category },
      )
      if (!enabled) {
        return { success: true, skipped: true }
      }
    }

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

/**
 * Recipients for a Hearth (personal camp) bondfire: the active
 * participants of that specific bondfire, minus the creator. Hearth
 * notifications are localized to the conversation — never the whole
 * Hearth membership — and have no mute concept (Hearths aren't camps).
 */
export const getHearthBondfireRecipientIds = internalQuery({
  args: {
    bondfireId: v.id('bondfires'),
    creatorId: v.id('users'),
  },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('status', 'active'),
      )
      .collect()

    return uniqueUserIds(
      participants
        .map((participant) => participant.userId)
        .filter((userId) => userId !== args.creatorId),
    )
  },
})

export const getPersonalCampName = internalQuery({
  args: { personalCampId: v.id('personalCamps') },
  handler: async (ctx, args): Promise<string | null> => {
    const personalCamp = await ctx.db.get(args.personalCampId)
    return personalCamp?.name ?? null
  },
})

/** Users who pinned this creator to their Close Circle — they get
 * personalized copy for the creator's camp activity (mute still applies). */
export const getCloseCirclePinnerIds = internalQuery({
  args: { pinnedUserId: v.id('users') },
  handler: async (ctx, args): Promise<Array<Id<'users'>>> => {
    const pins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_pinned', (q) => q.eq('pinnedUserId', args.pinnedUserId))
      .collect()
    return uniqueUserIds(pins.map((pin) => pin.ownerId))
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

    if (bondfire.personalCampId) {
      const participants = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire_status', (q) =>
          q.eq('bondfireId', args.bondfireId).eq('status', 'active'),
        )
        .collect()

      return uniqueUserIds(
        participants
          .map((participant) => participant.userId)
          .filter((userId) => userId !== args.responderId),
      )
    }

    // Responses only notify people who have participated in *this* bondfire:
    // the creator plus anyone who has already responded. Being in the camp is
    // not enough — that's what the spark (Camp activity) notification is for.
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

    // Camp bondfires: drop participants who have since left or muted the camp.
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
    if (!bondfire) {
      return { success: true, skipped: true }
    }

    // Hearth bondfires: notify the bondfire's active participants only.
    if (!bondfire.campId && bondfire.personalCampId) {
      const hearthRecipientIds: Array<Id<'users'>> = await ctx.runQuery(
        internal.sendNotification.getHearthBondfireRecipientIds,
        { bondfireId: args.bondfireId, creatorId: args.creatorId },
      )

      const claimedHearthIds: Array<Id<'users'>> = await ctx.runMutation(
        internal.sendNotification.claimDeliveries,
        {
          userIds: hearthRecipientIds,
          videoKey: args.bondfireId,
          threadKey: args.bondfireId,
        },
      )

      if (claimedHearthIds.length === 0) {
        return { success: true, skipped: true }
      }

      const hearthName: string | null = await ctx.runQuery(
        internal.sendNotification.getPersonalCampName,
        { personalCampId: bondfire.personalCampId },
      )

      await Promise.all(
        claimedHearthIds.map((userId) =>
          ctx.runAction(internal.sendNotification.sendToUser, {
            userId,
            title: hearthName ?? 'Your Hearth',
            body: `${args.creatorName} sparked a new Bondfire`,
            category: 'hearth',
            data: {
              type: 'hearth_bondfire',
              bondfireId: args.bondfireId,
              personalCampId: bondfire.personalCampId,
            },
          }),
        ),
      )

      return { success: true }
    }

    if (!bondfire.campId) {
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

    // Skip anyone already notified about this video (e.g. at live-start).
    const claimedIds: Array<Id<'users'>> = await ctx.runMutation(
      internal.sendNotification.claimDeliveries,
      {
        userIds: recipientIds,
        videoKey: args.bondfireId,
        threadKey: args.bondfireId,
      },
    )

    if (claimedIds.length === 0) {
      return { success: true, skipped: true }
    }

    const copy = getCampNotificationCopy(camp, args.creatorName)

    // Personalized copy for recipients who pinned this creator to their
    // Close Circle (regular bondfires only — crisis/welcome copy wins).
    const isRegularCopy = !camp.crisisBroadcast && !camp.welcomeBroadcast
    const pinnerIds: Array<Id<'users'>> = isRegularCopy
      ? await ctx.runQuery(internal.sendNotification.getCloseCirclePinnerIds, {
          pinnedUserId: args.creatorId,
        })
      : []
    const pinnerSet = new Set(pinnerIds)

    await Promise.all(
      claimedIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: copy.title,
          body: pinnerSet.has(userId)
            ? `${args.creatorName} from your Close Circle sparked a new Bondfire`
            : copy.body,
          category: 'recording',
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

// Send notification when someone responds to a bondfire.
// Deduped per video and throttled to 1 response push per bondfire per
// recipient per hour; throttled responses are absorbed silently.
export const notifyBondfireResponse = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    responderId: v.id('users'),
    responderName: v.string(),
    // The response video this push is about (used as the dedupe key so a
    // live-start push suppresses the publish-time push for the same video).
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
    // True when sent at live-start (stream watchable) rather than publish.
    isLive: v.optional(v.boolean()),
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

    const isHearth = !!bondfire.personalCampId
    const videoKey: string = args.bondfireVideoId ?? `${args.bondfireId}:resp:${args.responderId}`
    // Throttle responses against prior *response* deliveries only. The spark
    // and live notifications write to threadKey `bondfireId`; if responses
    // shared that bucket, the spark push (sent at bondfire creation) would
    // suppress every response push for the next hour — exactly when replies
    // actually happen. A dedicated `:resp` namespace keeps the throttle scoped
    // to responses without letting spark/live poison it.
    //
    // Camp/standalone responses are capped at one push per bondfire per hour.
    // Hearths are intimate, rapid conversations, so every response notifies —
    // the per-video dedupe (videoKey) still prevents a live-start push and the
    // publish push for the same video from double-firing.
    const claimedIds: Array<Id<'users'>> = await ctx.runMutation(
      internal.sendNotification.claimDeliveries,
      {
        userIds: recipientIds,
        videoKey,
        threadKey: `${args.bondfireId}:resp`,
        throttleMs: isHearth ? undefined : RESPONSE_THROTTLE_MS,
      },
    )

    if (claimedIds.length === 0) {
      return { success: true, skipped: true }
    }

    const body = args.isLive
      ? bondfire.title
        ? `${args.responderName} is responding in "${bondfire.title}" — watch live or later`
        : `${args.responderName} is responding live — watch now or later`
      : `${args.responderName} added a video to a Bondfire you're in`

    await Promise.all(
      claimedIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: 'New response',
          body,
          category: bondfire.personalCampId ? 'hearth' : 'responses',
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

    // Resolve recipients + notification title by context (camp vs. Hearth).
    let recipientIds: Array<Id<'users'>> = []
    let title = 'Live now'
    let crisisOrWelcomeCopy: { title: string; body: string } | null = null

    if (bondfire.campId) {
      recipientIds = await ctx.runQuery(internal.sendNotification.getLiveNotificationRecipientIds, {
        creatorId: args.creatorId,
        campId: bondfire.campId,
      })
      const camp = await ctx.runQuery(internal.sendNotification.getCampNotificationDetails, {
        campId: bondfire.campId,
      })
      if (camp) {
        title = camp.name
        if (camp.crisisBroadcast || camp.welcomeBroadcast) {
          crisisOrWelcomeCopy = getCampNotificationCopy(camp, args.creatorName)
        }
      }
    } else if (bondfire.personalCampId) {
      recipientIds = await ctx.runQuery(internal.sendNotification.getHearthBondfireRecipientIds, {
        bondfireId: args.bondfireId,
        creatorId: args.creatorId,
      })
      const hearthName: string | null = await ctx.runQuery(
        internal.sendNotification.getPersonalCampName,
        { personalCampId: bondfire.personalCampId },
      )
      title = hearthName ?? 'Your Hearth'
    }

    // Claim so the publish-time notification skips these recipients.
    const claimedIds: Array<Id<'users'>> = await ctx.runMutation(
      internal.sendNotification.claimDeliveries,
      {
        userIds: recipientIds,
        videoKey: args.bondfireId,
        threadKey: args.bondfireId,
      },
    )

    if (claimedIds.length === 0) {
      return { success: true, skipped: true }
    }

    const body =
      crisisOrWelcomeCopy?.body ??
      (bondfire.title
        ? `${args.creatorName} is sharing "${bondfire.title}" — watch live or later`
        : `${args.creatorName} is sharing a Bondfire — watch live or later`)

    // Personalized copy for Close Circle pinners (regular copy only).
    const livePinnerIds: Array<Id<'users'>> =
      !crisisOrWelcomeCopy && bondfire.campId
        ? await ctx.runQuery(internal.sendNotification.getCloseCirclePinnerIds, {
            pinnedUserId: args.creatorId,
          })
        : []
    const livePinnerSet = new Set(livePinnerIds)
    const pinnerBody = bondfire.title
      ? `${args.creatorName} from your Close Circle is sharing "${bondfire.title}" — watch live or later`
      : `${args.creatorName} from your Close Circle is sharing a Bondfire — watch live or later`

    await Promise.all(
      claimedIds.map((userId) =>
        ctx.runAction(internal.sendNotification.sendToUser, {
          userId,
          title: crisisOrWelcomeCopy?.title ?? title,
          body: livePinnerSet.has(userId) ? pinnerBody : body,
          category: bondfire.campId ? 'recording' : 'hearth',
          data: {
            type: 'bondfire_live',
            bondfireId: args.bondfireId,
            campId: bondfire.campId,
            personalCampId: bondfire.personalCampId,
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
      category: 'membership',
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

// ── Shared email helper (Resend) ──

async function sendResendEmail(options: {
  to: string
  subject: string
  heading: string
  bodyHtml: string
  ctaLabel: string
  ctaUrl: string
  footer: string
}): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { success: true }
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Bondfires <support@bondfires.org>',
        to: options.to,
        subject: options.subject,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #F59E0B; margin-bottom: 8px;">${options.heading}</h1>
            <p style="font-size: 16px; color: #333; line-height: 1.5;">
              ${options.bodyHtml}
            </p>
            <div style="margin-top: 24px;">
              <a href="${options.ctaUrl}"
                 style="display: inline-block; background: #D97736; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                ${options.ctaLabel}
              </a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
            <p style="font-size: 12px; color: #999;">${options.footer}</p>
          </div>
        `,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Failed to send email:', error)
      return { success: false, error }
    }

    return { success: true }
  } catch (error) {
    console.error('Error sending email:', error)
    return { success: false, error: String(error) }
  }
}

/** Camp lookup without the participable-status filter — lifecycle
 * notifications are precisely about frozen/grace/inactive camps. */
export const getCampAnyStatus = internalQuery({
  args: { campId: v.id('camps') },
  handler: async (ctx, args): Promise<Doc<'camps'> | null> => {
    return await ctx.db.get(args.campId)
  },
})

// ── Access Approved Notifications ──
// Denials are intentionally silent (product decision, June 2026).

/** Push to the requester when their camp access request is approved. */
export const notifyAccessApproved = internalAction({
  args: {
    campId: v.id('camps'),
    userId: v.id('users'),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const camp = await ctx.runQuery(internal.sendNotification.getCampAnyStatus, {
      campId: args.campId,
    })
    if (!camp) {
      return { success: false, error: 'Camp not found' }
    }

    return await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: args.userId,
      title: `${camp.name} let you in`,
      body: "You're now a member. Tap to look around.",
      category: 'membership',
      data: {
        type: 'camp_access_approved',
        campId: args.campId,
      },
    })
  },
})

/** Email to the requester when their camp access request is approved. */
export const emailAccessApproved = internalAction({
  args: {
    campId: v.id('camps'),
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    // Email follows the same preference as the push so they stay consistent.
    const enabled: boolean = await ctx.runQuery(
      internal.sendNotification.isCategoryEnabledForUser,
      { userId: args.userId, category: 'membership' },
    )
    if (!enabled) {
      return { success: true }
    }

    const camp = await ctx.runQuery(internal.sendNotification.getCampAnyStatus, {
      campId: args.campId,
    })
    if (!camp) {
      return { success: false, error: 'Camp not found' }
    }

    const user = await ctx.runQuery(internal.sendNotification.getUserEmail, {
      userId: args.userId,
    })
    if (!user?.email) {
      return { success: true }
    }

    const safeCampName = escapeHtml(camp.name)
    return await sendResendEmail({
      to: user.email,
      subject: `You're in — welcome to ${camp.name}`,
      heading: "You're in",
      bodyHtml: `Your request to join <strong>${safeCampName}</strong> was approved. Pull up a log — the fire's going.`,
      ctaLabel: 'Visit the Camp',
      ctaUrl: `https://bondfires.org/camp/${args.campId}`,
      footer:
        'This email was sent automatically by Bondfires because your access request was approved.',
    })
  },
})

// ── Hearth Join Notification ──

/** Notify a Hearth bondfire's creator when someone joins the conversation. */
export const notifyHearthJoin = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    joinerId: v.id('users'),
    joinerName: v.string(),
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
    if (!bondfire?.personalCampId || bondfire.userId === args.joinerId) {
      return { success: true, skipped: true }
    }

    const hearthName: string | null = await ctx.runQuery(
      internal.sendNotification.getPersonalCampName,
      { personalCampId: bondfire.personalCampId },
    )

    return await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: bondfire.userId,
      title: hearthName ?? 'Your Hearth',
      body: `${args.joinerName} joined the conversation`,
      category: 'hearth',
      data: {
        type: 'hearth_join',
        bondfireId: args.bondfireId,
        personalCampId: bondfire.personalCampId,
      },
    })
  },
})

// ── Camp Lifecycle Warnings ──
// Push + email to the owner at each lifecycle transition, and a final
// reminder 3 days before the reclaim deadline. Email matters here: an
// owner drifting away from the app is exactly who push won't reach.

const lifecycleStage = v.union(
  v.literal('grace'),
  v.literal('frozen'),
  v.literal('inactive'),
  v.literal('reclaim_reminder'),
)

function formatDeadline(timestamp: number | undefined): string {
  if (!timestamp) return 'soon'
  try {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return 'soon'
  }
}

function getLifecycleCopy(
  camp: Doc<'camps'>,
): Record<
  'grace' | 'frozen' | 'inactive' | 'reclaim_reminder',
  { title: string; body: string; subject: string; emailBody: string }
> {
  const graceEnds = formatDeadline(camp.gracePeriodEnd)
  const reclaimBy = formatDeadline(camp.reclaimDeadline)
  const safeName = escapeHtml(camp.name)

  return {
    grace: {
      title: `${camp.name} needs kindling`,
      body: `Add kindling by ${graceEnds} to keep the fire burning`,
      subject: `${camp.name} needs kindling`,
      emailBody: `<strong>${safeName}</strong> has run out of kindling and entered its grace period. Add kindling by <strong>${graceEnds}</strong> to keep the camp active.`,
    },
    frozen: {
      title: `${camp.name} is frozen`,
      body: `Reclaim your camp by ${reclaimBy} before it's archived`,
      subject: `${camp.name} is frozen`,
      emailBody: `<strong>${safeName}</strong> was frozen because it's no longer covered by your subscription. Reclaim it by <strong>${reclaimBy}</strong> or it will be archived.`,
    },
    inactive: {
      title: `${camp.name} went quiet`,
      body: `Reclaim your camp by ${reclaimBy} before it's archived`,
      subject: `${camp.name} is inactive`,
      emailBody: `<strong>${safeName}</strong>'s grace period ended and the camp is now inactive. Reclaim it by <strong>${reclaimBy}</strong> or it will be archived.`,
    },
    reclaim_reminder: {
      title: `${camp.name} archives soon`,
      body: `Last chance — reclaim your camp by ${reclaimBy}`,
      subject: `Last chance to reclaim ${camp.name}`,
      emailBody: `<strong>${safeName}</strong> will be archived after <strong>${reclaimBy}</strong>. Reclaim it now to keep the camp and its Bondfires.`,
    },
  }
}

/** Push + email to the camp owner for a lifecycle transition. */
export const notifyCampLifecycle = internalAction({
  args: {
    campId: v.id('camps'),
    stage: lifecycleStage,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean
    skipped?: boolean
    error?: string
  }> => {
    const camp = await ctx.runQuery(internal.sendNotification.getCampAnyStatus, {
      campId: args.campId,
    })
    if (!camp?.ownerId) {
      return { success: true, skipped: true }
    }

    // Idempotency: lifecycle crons re-run safely, so claim a delivery key
    // tied to this camp + stage + deadline before sending anything.
    const deadline = camp.reclaimDeadline ?? camp.gracePeriodEnd ?? 0
    const claimed: Array<Id<'users'>> = await ctx.runMutation(
      internal.sendNotification.claimDeliveries,
      {
        userIds: [camp.ownerId],
        videoKey: `campstage:${args.campId}:${args.stage}:${deadline}`,
        threadKey: `campstage:${args.campId}`,
      },
    )
    if (claimed.length === 0) {
      return { success: true, skipped: true }
    }

    const copy = getLifecycleCopy(camp)[args.stage]

    await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: camp.ownerId,
      title: copy.title,
      body: copy.body,
      category: 'account',
      data: {
        type: 'camp_lifecycle',
        stage: args.stage,
        campId: args.campId,
      },
    })

    const owner = await ctx.runQuery(internal.sendNotification.getUserEmail, {
      userId: camp.ownerId,
    })
    if (owner?.email) {
      await sendResendEmail({
        to: owner.email,
        subject: copy.subject,
        heading: copy.title,
        bodyHtml: copy.emailBody,
        ctaLabel: 'Manage Camp',
        ctaUrl: `https://bondfires.org/camp/${args.campId}`,
        footer: 'This email was sent automatically by Bondfires because you are the camp owner.',
      })
    }

    return { success: true }
  },
})

const RECLAIM_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export const listCampsNearingReclaimDeadline = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<Id<'camps'>>> => {
    const now = Date.now()
    const cutoff = now + RECLAIM_WARNING_WINDOW_MS
    const camps = await ctx.db
      .query('camps')
      .filter((q) =>
        q.and(
          q.or(q.eq(q.field('status'), 'frozen'), q.eq(q.field('status'), 'inactive')),
          q.gt(q.field('reclaimDeadline'), now),
          q.lte(q.field('reclaimDeadline'), cutoff),
        ),
      )
      .collect()
    return camps.map((camp) => camp._id)
  },
})

/** Daily cron: final warning to owners 3 days before reclaim deadline. */
export const sendReclaimWarnings = internalAction({
  args: {},
  handler: async (ctx): Promise<{ warned: number }> => {
    const campIds: Array<Id<'camps'>> = await ctx.runQuery(
      internal.sendNotification.listCampsNearingReclaimDeadline,
      {},
    )

    for (const campId of campIds) {
      await ctx.runAction(internal.sendNotification.notifyCampLifecycle, {
        campId,
        stage: 'reclaim_reminder',
      })
    }

    return { warned: campIds.length }
  },
})
