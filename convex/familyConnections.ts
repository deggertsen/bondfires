import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { assertUserAgeBand, getPersonalCampAgeBand, getUserAgeBand } from './agePolicy'
import { auth } from './auth'
import { throwUserError } from './errors'
import {
  familyPairKey,
  getActiveFamilyConnection,
  hasFamilyConnectionCapacity,
  MAX_ACTIVE_FAMILY_CONNECTIONS,
} from './familyRelationships'
import { generateAndInsertInviteCode, normalizeInviteCode } from './inviteCodes'
import { ensureActivePersonalBondfireParticipant } from './personalBondfireAccess'

const FAMILY_INVITE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_FAMILY_INVITES_PER_DAY = 20
const REVOCATION_CLEANUP_BATCH = 50

async function getCurrentUser(ctx: QueryCtx | MutationCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) throwUserError('Not authenticated')
  const user = await ctx.db.get(userId)
  if (!user) throwUserError('User not found')
  return user
}

function orderedPair(firstUserId: Id<'users'>, secondUserId: Id<'users'>) {
  return String(firstUserId) < String(secondUserId)
    ? { firstUserId, secondUserId }
    : { firstUserId: secondUserId, secondUserId: firstUserId }
}

function familyInviteCode(): string {
  return `family-${crypto.randomUUID().replaceAll('-', '')}`
}

async function getFamilyInvite(ctx: QueryCtx | MutationCtx, rawCode: string) {
  const code = normalizeInviteCode(rawCode)
  if (!code || code.length > 80) return null
  const invite = await ctx.db
    .query('inviteCodes')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first()
  return invite?.parentType === 'family-connection' ? invite : null
}

async function requireFamilyInvite(ctx: QueryCtx | MutationCtx, rawCode: string) {
  const invite = await getFamilyInvite(ctx, rawCode)
  const now = Date.now()
  if (!invite) throwUserError('Family invitation not found.')
  if (invite.expiresAt === undefined || invite.expiresAt <= now) {
    throwUserError('This family invitation has expired.')
  }
  if (invite.maxUses !== 1 || invite.uses >= invite.maxUses) {
    throwUserError('This family invitation has already been used.')
  }
  return invite
}

async function removeParticipantGrantBatch(
  ctx: MutationCtx,
  connectionId: Id<'familyConnections'>,
) {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_family_connection_status', (q) =>
      q.eq('familyConnectionId', connectionId).eq('status', 'active'),
    )
    .take(REVOCATION_CLEANUP_BATCH)
  const now = Date.now()
  for (const participant of participants) {
    await ctx.db.patch(participant._id, {
      status: 'removed',
      removedAt: now,
      removedBy: undefined,
      updatedAt: now,
    })
  }
  return participants.length
}

/**
 * Create a short-lived, single-use family link for one Hearth Bondfire. This
 * is deliberately separate from ordinary share links so cross-age access can
 * never be granted accidentally.
 */
export const createInvite = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const owner = await getCurrentUser(ctx)
    assertUserAgeBand(owner)
    const bondfire = await ctx.db.get(args.bondfireId)
    const now = Date.now()
    if (
      !bondfire?.personalCampId ||
      bondfire.userId !== owner._id ||
      (bondfire.expiresAt !== undefined && bondfire.expiresAt <= now)
    ) {
      throwUserError('Only the Hearth Bondfire owner can create a family invitation.')
    }
    const personalCamp = await ctx.db.get(bondfire.personalCampId)
    if (
      !personalCamp ||
      personalCamp.status !== 'active' ||
      getPersonalCampAgeBand(personalCamp) !== getUserAgeBand(owner)
    ) {
      throwUserError('Your Hearth is currently unavailable.')
    }

    const recent = await ctx.db
      .query('inviteCodes')
      .withIndex('by_created_by_type', (q) =>
        q
          .eq('createdBy', owner._id)
          .eq('parentType', 'family-connection')
          .gte('createdAt', now - FAMILY_INVITE_TTL_MS),
      )
      .order('desc')
      .take(MAX_FAMILY_INVITES_PER_DAY)
    if (recent.length >= MAX_FAMILY_INVITES_PER_DAY) {
      throwUserError('You have created too many family invitations today. Try again tomorrow.')
    }

    const result = await generateAndInsertInviteCode(ctx, {
      parentType: 'family-connection',
      parentId: args.bondfireId,
      createdBy: owner._id,
      code: familyInviteCode(),
      expiresAt: now + FAMILY_INVITE_TTL_MS,
      maxUses: 1,
    })
    return { ...result, bondfireId: args.bondfireId }
  },
})

/** Safe preview for the explicit acceptance screen. */
export const checkInvite = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const invite = await getFamilyInvite(ctx, args.code)
    const now = Date.now()
    if (!invite) return { valid: false, reason: 'not_found' as const }
    if (invite.expiresAt === undefined || invite.expiresAt <= now) {
      return { valid: false, reason: 'expired' as const }
    }
    if (invite.maxUses !== 1 || invite.uses >= invite.maxUses) {
      return { valid: false, reason: 'used' as const }
    }
    const [bondfire, inviter] = await Promise.all([
      ctx.db.get(invite.parentId as Id<'bondfires'>),
      ctx.db.get(invite.createdBy),
    ])
    if (
      !bondfire?.personalCampId ||
      bondfire.userId !== invite.createdBy ||
      !inviter ||
      (bondfire.expiresAt !== undefined && bondfire.expiresAt <= now)
    ) {
      return { valid: false, reason: 'ended' as const }
    }
    const personalCamp = await ctx.db.get(bondfire.personalCampId)
    if (
      !personalCamp ||
      personalCamp.status !== 'active' ||
      getPersonalCampAgeBand(personalCamp) !== getUserAgeBand(inviter)
    ) {
      return { valid: false, reason: 'unavailable' as const }
    }
    return {
      valid: true,
      inviterName: inviter.displayName ?? inviter.name ?? 'A family member',
      bondfireTitle: bondfire.title,
      expiresAt: invite.expiresAt,
    }
  },
})

/**
 * Explicit acceptance creates (or reuses) the relationship and grants access
 * only to the Bondfire named by this one-time link.
 */
export const acceptInvite = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const recipient = await getCurrentUser(ctx)
    assertUserAgeBand(recipient)
    const invite = await requireFamilyInvite(ctx, args.code)
    const now = Date.now()
    if (invite.createdBy === recipient._id) {
      throwUserError('You cannot accept your own family invitation.')
    }

    const [owner, bondfire] = await Promise.all([
      ctx.db.get(invite.createdBy),
      ctx.db.get(invite.parentId as Id<'bondfires'>),
    ])
    if (
      !owner ||
      !bondfire?.personalCampId ||
      bondfire.userId !== owner._id ||
      (bondfire.expiresAt !== undefined && bondfire.expiresAt <= now)
    ) {
      throwUserError('This family invitation is no longer available.')
    }
    assertUserAgeBand(owner)

    let connection = await getActiveFamilyConnection(ctx, owner._id, recipient._id)
    if (!connection) {
      const [ownerHasCapacity, recipientHasCapacity] = await Promise.all([
        hasFamilyConnectionCapacity(ctx, owner._id),
        hasFamilyConnectionCapacity(ctx, recipient._id),
      ])
      if (!ownerHasCapacity || !recipientHasCapacity) {
        throwUserError(
          `Family connections are limited to ${MAX_ACTIVE_FAMILY_CONNECTIONS} per account. Remove an existing connection before accepting another.`,
        )
      }
      const pair = orderedPair(owner._id, recipient._id)
      const connectionId = await ctx.db.insert('familyConnections', {
        pairKey: familyPairKey(owner._id, recipient._id),
        ...pair,
        status: 'active',
        initiatedBy: owner._id,
        acceptedBy: recipient._id,
        sourceBondfireId: bondfire._id,
        sourceInviteCodeId: invite._id,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      connection = await ctx.db.get(connectionId)
    }
    if (!connection) throw new Error('Failed to create family connection')

    const participant = await ensureActivePersonalBondfireParticipant(ctx, {
      bondfire,
      userId: recipient._id,
      errorAudience: 'invitee',
      familyConnectionId: connection._id,
    })
    await ctx.db.patch(invite._id, { uses: invite.uses + 1 })

    if (participant.added) {
      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyHearthJoin, {
        bondfireId: bondfire._id,
        joinerId: recipient._id,
        joinerName: recipient.displayName ?? recipient.name ?? 'Someone',
      })
    }

    return { bondfireId: bondfire._id, connectionId: connection._id }
  },
})

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx)
    const [asFirst, asSecond] = await Promise.all([
      ctx.db
        .query('familyConnections')
        .withIndex('by_first_status', (q) => q.eq('firstUserId', user._id).eq('status', 'active'))
        .order('desc')
        .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
      ctx.db
        .query('familyConnections')
        .withIndex('by_second_status', (q) => q.eq('secondUserId', user._id).eq('status', 'active'))
        .order('desc')
        .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
    ])
    const connections = [...asFirst, ...asSecond]
      .sort((a, b) => b.acceptedAt - a.acceptedAt)
      .slice(0, MAX_ACTIVE_FAMILY_CONNECTIONS)
    const rows = await Promise.all(
      connections.map(async (connection) => {
        const otherUserId =
          connection.firstUserId === user._id ? connection.secondUserId : connection.firstUserId
        const other = await ctx.db.get(otherUserId)
        if (!other) return null
        return {
          _id: connection._id,
          acceptedAt: connection.acceptedAt,
          initiatedByMe: connection.initiatedBy === user._id,
          user: {
            _id: other._id,
            displayName: other.displayName,
            name: other.name,
            photoUrl: other.photoUrl,
          },
        }
      }),
    )
    return rows.filter((row) => row !== null)
  },
})

export const revoke = mutation({
  args: { connectionId: v.id('familyConnections') },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const connection = await ctx.db.get(args.connectionId)
    if (
      !connection ||
      (connection.firstUserId !== user._id && connection.secondUserId !== user._id)
    ) {
      throwUserError('Family connection not found.')
    }
    if (connection.status === 'revoked') return { revoked: false }

    const now = Date.now()
    await ctx.db.patch(connection._id, {
      status: 'revoked',
      revokedAt: now,
      revokedBy: user._id,
      updatedAt: now,
    })
    const removed = await removeParticipantGrantBatch(ctx, connection._id)
    if (removed === REVOCATION_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.familyConnections.removeRevokedParticipantGrants, {
        connectionId: connection._id,
      })
    }
    return { revoked: true }
  },
})

export const removeRevokedParticipantGrants = internalMutation({
  args: { connectionId: v.id('familyConnections') },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId)
    if (!connection || connection.status !== 'revoked') return { removed: 0, done: true }
    const removed = await removeParticipantGrantBatch(ctx, connection._id)
    if (removed === REVOCATION_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.familyConnections.removeRevokedParticipantGrants, {
        connectionId: connection._id,
      })
    }
    return { removed, done: removed < REVOCATION_CLEANUP_BATCH }
  },
})
