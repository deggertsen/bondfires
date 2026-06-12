import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, mutation, query } from './_generated/server'
import { auth } from './auth'
import { buildViewerVisibilityContext, isCampContentVisibleToViewer } from './bondfireVisibility'

// ── Constants ──────────────────────────────────────────────────────────────

const INTERACTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ── Unified Invitable Contacts ──────────────────────────────────────────────

/**
 * List people the current user can invite — anyone they've interacted with
 * (same camp membership or responded to their bondfire) in the last 30 days.
 * Deduped and sorted by recency. Excludes the current user.
 */
export const listInvitableContacts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) return []

    const cutoff = Date.now() - INTERACTION_WINDOW_MS
    const contactMap = new Map<string, number>() // userId -> latest interaction time

    // 1. Get all camp memberships for the current user (any status)
    const myMemberships = await ctx.db
      .query('campMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    const campIds = myMemberships.map((m) => m.campId)

    // 2. Get all other members from those camps (recent activity)
    for (const campId of campIds) {
      const members = await ctx.db
        .query('campMembers')
        .withIndex('by_camp', (q) => q.eq('campId', campId))
        .filter((q) => q.gte(q.field('_creationTime'), cutoff))
        .collect()

      for (const m of members) {
        if (m.userId === userId) continue
        const existing = contactMap.get(m.userId)
        if (!existing || m._creationTime > existing) {
          contactMap.set(m.userId, m._creationTime)
        }
      }
    }

    // 3. Get people who responded to the user's bondfires recently
    const myBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    for (const bondfire of myBondfires) {
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .filter((q) => q.neq(q.field('userId'), userId))
        .filter((q) => q.gte(q.field('_creationTime'), cutoff))
        .collect()

      for (const r of responses) {
        const existing = contactMap.get(r.userId)
        if (!existing || r._creationTime > existing) {
          contactMap.set(r.userId, r._creationTime)
        }
      }
    }

    // 4. Get bondfire creators the user responded to recently
    const myResponses = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .filter((q) => q.gte(q.field('_creationTime'), cutoff))
      .collect()

    const respondedBondfireIds = [...new Set(myResponses.map((r) => r.bondfireId))]

    for (const bondfireId of respondedBondfireIds) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire || bondfire.userId === userId) continue
      const existing = contactMap.get(bondfire.userId)
      const time = Math.max(bondfire._creationTime, cutoff)
      if (!existing || time > existing) {
        contactMap.set(bondfire.userId, time)
      }
    }

    // Sort by most recent, limit to 30
    const sorted = [...contactMap.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 30)
      .map(([uid]) => uid)

    const users = await Promise.all(sorted.map((id) => ctx.db.get(id as Id<'users'>)))
    return users
      .filter((u): u is Doc<'users'> => u !== null)
      .map((u) => ({
        _id: u._id,
        displayName: u.displayName,
        name: u.name,
        photoUrl: u.photoUrl,
      }))
  },
})

// ── Bondfire Invite ─────────────────────────────────────────────────────────

/**
 * Send a bondfire invite to another user. Creates an invite record and sends
 * a push notification to the recipient.
 */
export const sendBondfireInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    recipientId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('You must be logged in')

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) throw new Error('Bondfire not found')

    // Verify sender has permission to invite for this bondfire's camp
    const sender = await ctx.db.get(userId)
    if (!sender) throw new Error('User not found')

    const senderName = sender.displayName ?? sender.name ?? 'Someone'

    // Check if sender is the bondfire creator or has camp invite permission
    const isCreator = bondfire.userId === userId
    let hasCampPermission = false

    if (bondfire.campId) {
      const campId = bondfire.campId
      const membership = await ctx.db
        .query('campMembers')
        .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
        .unique()

      // Allow invite if user is owner, moderator, or the camp is public (all members can invite)
      if (membership) {
        const camp = await ctx.db.get(campId)
        hasCampPermission =
          membership.role === 'owner' ||
          membership.role === 'moderator' ||
          (camp?.access === 'open' && membership.status === 'active')
      }
    }

    if (!isCreator && !hasCampPermission) {
      throw new Error('You do not have permission to invite people to this bondfire')
    }

    // Prevent self-invite
    if (args.recipientId === userId) {
      throw new Error('You cannot invite yourself')
    }

    // Don't create a duplicate invite if one already exists (idempotent)
    const existingInvite = await ctx.db
      .query('bondfireInvites')
      .withIndex('by_bondfire_recipient', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('recipientId', args.recipientId),
      )
      .unique()

    if (existingInvite) {
      // Still send the notification again even if the invite exists
      await ctx.scheduler.runAfter(0, internal.bondfireInvites.sendBondfireInviteNotification, {
        bondfireId: args.bondfireId,
        recipientId: args.recipientId,
        senderName,
        bondfireCreatorName: bondfire.creatorName ?? 'Someone',
        campId: bondfire.campId,
      })
      return existingInvite._id
    }

    const inviteId = await ctx.db.insert('bondfireInvites', {
      bondfireId: args.bondfireId,
      senderId: userId,
      recipientId: args.recipientId,
      createdAt: Date.now(),
      seen: false,
    })

    // Send push notification to recipient
    await ctx.scheduler.runAfter(0, internal.bondfireInvites.sendBondfireInviteNotification, {
      bondfireId: args.bondfireId,
      recipientId: args.recipientId,
      senderName,
      bondfireCreatorName: bondfire.creatorName ?? 'Someone',
      campId: bondfire.campId,
    })

    return inviteId
  },
})

// ── Internal Notification Action ────────────────────────────────────────────

export const sendBondfireInviteNotification = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    recipientId: v.id('users'),
    senderName: v.string(),
    bondfireCreatorName: v.string(),
    campId: v.optional(v.id('camps')),
  },
  handler: async (ctx, args) => {
    const screenPath = `/bondfire/${args.bondfireId}`

    await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: args.recipientId,
      title: `${args.senderName} shared a bondfire with you`,
      body: `"${args.bondfireCreatorName}" — tap to watch`,
      category: 'membership',
      data: {
        type: 'bondfire_invite',
        bondfireId: args.bondfireId,
        screen: screenPath,
        campId: args.campId,
      },
    })
  },
})

// ── Can Access Bondfire ────────────────────────────────────────────────────

/**
 * Check if a user can access a bondfire. Returns null if access is denied,
 * or { needsCampJoin: true } if the user can access but needs to join the camp.
 */
export const canAccessBondfire = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) return null

    if (!bondfire.campId) {
      return { needsCampJoin: false, campId: null }
    }

    const campId = bondfire.campId
    const camp = await ctx.db.get(campId)
    if (!camp) return null

    if (!userId) {
      if (camp.access === 'open') {
        return { needsCampJoin: false, campId: camp._id }
      }
      return null
    }

    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .unique()

    if (membership && membership.status === 'active') {
      return { needsCampJoin: false, campId: camp._id }
    }

    if (camp.access === 'open') {
      // Only show the join prompt if the camp is actually visible/joinable for
      // this user (readable status + gender, age, and tier rules from
      // rules.access with hide-mode visibility).
      const viewer = await buildViewerVisibilityContext(ctx, userId)
      if (!isCampContentVisibleToViewer(camp, viewer)) {
        return null
      }
      return { needsCampJoin: true, campId: camp._id }
    }

    return null
  },
})
