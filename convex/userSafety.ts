import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'
import { revokeFamilyConnection } from './familyConnectionRevocation'

type DbCtx = QueryCtx | MutationCtx
const BLOCK_ARTIFACT_CLEANUP_BATCH = 25

async function deleteBlockedPairArtifactsBatch(
  ctx: MutationCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
  createdThrough: number,
) {
  const [firstClaims, secondClaims, firstInvites, secondInvites] = await Promise.all([
    ctx.db
      .query('inviteClaims')
      .withIndex('by_sender_claimer', (q) =>
        q
          .eq('senderId', firstUserId)
          .eq('claimerId', secondUserId)
          .lte('createdAt', createdThrough),
      )
      .take(BLOCK_ARTIFACT_CLEANUP_BATCH),
    ctx.db
      .query('inviteClaims')
      .withIndex('by_sender_claimer', (q) =>
        q
          .eq('senderId', secondUserId)
          .eq('claimerId', firstUserId)
          .lte('createdAt', createdThrough),
      )
      .take(BLOCK_ARTIFACT_CLEANUP_BATCH),
    ctx.db
      .query('bondfireInvites')
      .withIndex('by_sender_recipient', (q) =>
        q
          .eq('senderId', firstUserId)
          .eq('recipientId', secondUserId)
          .lte('createdAt', createdThrough),
      )
      .take(BLOCK_ARTIFACT_CLEANUP_BATCH),
    ctx.db
      .query('bondfireInvites')
      .withIndex('by_sender_recipient', (q) =>
        q
          .eq('senderId', secondUserId)
          .eq('recipientId', firstUserId)
          .lte('createdAt', createdThrough),
      )
      .take(BLOCK_ARTIFACT_CLEANUP_BATCH),
  ])
  for (const row of [...firstClaims, ...secondClaims, ...firstInvites, ...secondInvites]) {
    await ctx.db.delete(row._id)
  }
  return [firstClaims, secondClaims, firstInvites, secondInvites].some(
    (rows) => rows.length === BLOCK_ARTIFACT_CLEANUP_BATCH,
  )
}

async function revokeActiveFamilyConnectionBetween(
  ctx: MutationCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
  revokedBy: Id<'users'>,
) {
  const [orderedFirst, orderedSecond] =
    String(firstUserId) < String(secondUserId)
      ? [firstUserId, secondUserId]
      : [secondUserId, firstUserId]
  const connection = await ctx.db
    .query('familyConnections')
    .withIndex('by_first_status', (q) => q.eq('firstUserId', orderedFirst).eq('status', 'active'))
    .filter((q) => q.eq(q.field('secondUserId'), orderedSecond))
    .first()
  if (connection) await revokeFamilyConnection(ctx, connection, revokedBy)
}

export function mergeBlockedUserIds(
  outgoing: Array<{ blockedUserId: Id<'users'> }>,
  incoming: Array<{ blockerId: Id<'users'> }>,
) {
  return new Set([
    ...outgoing.map((row) => row.blockedUserId),
    ...incoming.map((row) => row.blockerId),
  ])
}

export async function isEitherUserBlocked(
  ctx: DbCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
): Promise<boolean> {
  if (firstUserId === secondUserId) return false

  const [forward, reverse] = await Promise.all([
    ctx.db
      .query('userBlocks')
      .withIndex('by_blocker_blocked', (q) =>
        q.eq('blockerId', firstUserId).eq('blockedUserId', secondUserId),
      )
      .first(),
    ctx.db
      .query('userBlocks')
      .withIndex('by_blocker_blocked', (q) =>
        q.eq('blockerId', secondUserId).eq('blockedUserId', firstUserId),
      )
      .first(),
  ])

  return !!forward || !!reverse
}

export async function getBlockedUserIds(
  ctx: DbCtx,
  userId: Id<'users'>,
): Promise<Set<Id<'users'>>> {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query('userBlocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', userId))
      .collect(),
    ctx.db
      .query('userBlocks')
      .withIndex('by_blocked', (q) => q.eq('blockedUserId', userId))
      .collect(),
  ])

  return mergeBlockedUserIds(outgoing, incoming)
}

export async function assertUsersMayInteract(
  ctx: DbCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
) {
  if (await isEitherUserBlocked(ctx, firstUserId, secondUserId)) {
    throwUserError('This interaction is unavailable')
  }
}

export const block = mutation({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const blockerId = await auth.getUserId(ctx)
    if (!blockerId) throwUserError('Not authenticated')
    if (blockerId === args.userId) throwUserError('You cannot block yourself')
    if (!(await ctx.db.get(args.userId))) throwUserError('User not found')

    const existing = await ctx.db
      .query('userBlocks')
      .withIndex('by_blocker_blocked', (q) =>
        q.eq('blockerId', blockerId).eq('blockedUserId', args.userId),
      )
      .first()
    const blockedAt = existing?.createdAt ?? Date.now()
    const blockId =
      existing?._id ??
      (await ctx.db.insert('userBlocks', {
        blockerId,
        blockedUserId: args.userId,
        createdAt: blockedAt,
      }))

    // Authorization fails closed as soon as the block and connection
    // revocation commit. Bounded cleanup removes pre-block invite artifacts;
    // artifacts created after a later unblock are intentionally preserved.
    await revokeActiveFamilyConnectionBetween(ctx, blockerId, args.userId, blockerId)
    const moreArtifacts = await deleteBlockedPairArtifactsBatch(
      ctx,
      blockerId,
      args.userId,
      blockedAt,
    )
    if (moreArtifacts) {
      await ctx.scheduler.runAfter(0, internal.userSafety.removeBlockedPairArtifacts, {
        firstUserId: blockerId,
        secondUserId: args.userId,
        createdThrough: blockedAt,
      })
    }

    return blockId
  },
})

export const removeBlockedPairArtifacts = internalMutation({
  args: {
    firstUserId: v.id('users'),
    secondUserId: v.id('users'),
    createdThrough: v.number(),
  },
  handler: async (ctx, args) => {
    const more = await deleteBlockedPairArtifactsBatch(
      ctx,
      args.firstUserId,
      args.secondUserId,
      args.createdThrough,
    )
    if (more) {
      await ctx.scheduler.runAfter(0, internal.userSafety.removeBlockedPairArtifacts, args)
    }
    return { done: !more }
  },
})

export const unblock = mutation({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const blockerId = await auth.getUserId(ctx)
    if (!blockerId) throwUserError('Not authenticated')
    const existing = await ctx.db
      .query('userBlocks')
      .withIndex('by_blocker_blocked', (q) =>
        q.eq('blockerId', blockerId).eq('blockedUserId', args.userId),
      )
      .first()
    if (existing) await ctx.db.delete(existing._id)
    return null
  },
})

export const listBlocked = query({
  args: {},
  handler: async (ctx) => {
    const blockerId = await auth.getUserId(ctx)
    if (!blockerId) return []
    const rows = await ctx.db
      .query('userBlocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', blockerId))
      .order('desc')
      .collect()
    const users = await Promise.all(rows.map((row) => ctx.db.get(row.blockedUserId)))
    return rows.map((row, index) => ({
      ...row,
      displayName: users[index]?.displayName ?? users[index]?.name ?? 'Blocked user',
      photoUrl: users[index]?.photoUrl,
    }))
  },
})
