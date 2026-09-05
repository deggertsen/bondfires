import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const REVOCATION_CLEANUP_BATCH = 50

export async function removeFamilyConnectionParticipantGrantBatch(
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
 * Revocation changes authorization state before cleanup is scheduled, so
 * reads fail closed even when a connection granted access to many Hearths.
 */
export async function revokeFamilyConnection(
  ctx: MutationCtx,
  connection: Doc<'familyConnections'>,
  revokedBy: Id<'users'>,
) {
  if (connection.status === 'revoked') return false

  const now = Date.now()
  await ctx.db.patch(connection._id, {
    status: 'revoked',
    revokedAt: now,
    revokedBy,
    updatedAt: now,
  })
  const removed = await removeFamilyConnectionParticipantGrantBatch(ctx, connection._id)
  if (removed === REVOCATION_CLEANUP_BATCH) {
    await ctx.scheduler.runAfter(0, internal.familyConnections.removeRevokedParticipantGrants, {
      connectionId: connection._id,
    })
  }
  return true
}

export function familyConnectionCleanupIsDone(removed: number) {
  return removed < REVOCATION_CLEANUP_BATCH
}
