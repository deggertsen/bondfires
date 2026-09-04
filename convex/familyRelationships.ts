import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { type AgeBand, getUserAgeBand } from './agePolicy'
import { throwUserError } from './errors'

type ConvexCtx = QueryCtx | MutationCtx

export const MAX_ACTIVE_FAMILY_CONNECTIONS = 50

type ConnectionGrant = Pick<
  Doc<'familyConnections'>,
  '_id' | 'firstUserId' | 'secondUserId' | 'status'
>

export type HearthRelationshipAuthorization =
  | { allowed: true; familyConnectionId?: Id<'familyConnections'> }
  | { allowed: false }

export function familyPairKey(firstUserId: Id<'users'>, secondUserId: Id<'users'>): string {
  return [String(firstUserId), String(secondUserId)].sort().join(':')
}

export function connectionMatchesPair(
  connection: Pick<ConnectionGrant, 'firstUserId' | 'secondUserId'>,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
): boolean {
  return (
    familyPairKey(connection.firstUserId, connection.secondUserId) ===
    familyPairKey(firstUserId, secondUserId)
  )
}

export function evaluateHearthRelationship(
  firstBand: AgeBand | null,
  secondBand: AgeBand | null,
  connection: ConnectionGrant | null,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
): HearthRelationshipAuthorization {
  if (!firstBand || !secondBand) return { allowed: false }
  if (firstBand === secondBand) return { allowed: true }
  if (
    connection?.status === 'active' &&
    connectionMatchesPair(connection, firstUserId, secondUserId)
  ) {
    return { allowed: true, familyConnectionId: connection._id }
  }
  return { allowed: false }
}

export function evaluateHearthParticipantGrant(
  ownerBand: AgeBand | null,
  participantBand: AgeBand | null,
  connection: ConnectionGrant | null,
  ownerId: Id<'users'>,
  participantId: Id<'users'>,
  familyConnectionId?: Id<'familyConnections'>,
): boolean {
  if (!ownerBand || !participantBand) return false
  if (familyConnectionId) {
    return (
      connection?._id === familyConnectionId &&
      connection.status === 'active' &&
      connectionMatchesPair(connection, ownerId, participantId)
    )
  }
  return ownerBand === participantBand
}

export async function getActiveFamilyConnection(
  ctx: ConvexCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
) {
  return await ctx.db
    .query('familyConnections')
    .withIndex('by_pair_status', (q) =>
      q.eq('pairKey', familyPairKey(firstUserId, secondUserId)).eq('status', 'active'),
    )
    .order('desc')
    .first()
}

export async function getActiveFamilyConnectionUserIds(
  ctx: ConvexCtx,
  userId: Id<'users'>,
): Promise<Id<'users'>[]> {
  const [asFirst, asSecond] = await Promise.all([
    ctx.db
      .query('familyConnections')
      .withIndex('by_first_status', (q) => q.eq('firstUserId', userId).eq('status', 'active'))
      .order('desc')
      .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
    ctx.db
      .query('familyConnections')
      .withIndex('by_second_status', (q) => q.eq('secondUserId', userId).eq('status', 'active'))
      .order('desc')
      .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
  ])
  return [
    ...new Set([
      ...asFirst.map((connection) => connection.secondUserId),
      ...asSecond.map((connection) => connection.firstUserId),
    ]),
  ].slice(0, MAX_ACTIVE_FAMILY_CONNECTIONS)
}

export async function hasFamilyConnectionCapacity(ctx: ConvexCtx, userId: Id<'users'>) {
  const [asFirst, asSecond] = await Promise.all([
    ctx.db
      .query('familyConnections')
      .withIndex('by_first_status', (q) => q.eq('firstUserId', userId).eq('status', 'active'))
      .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
    ctx.db
      .query('familyConnections')
      .withIndex('by_second_status', (q) => q.eq('secondUserId', userId).eq('status', 'active'))
      .take(MAX_ACTIVE_FAMILY_CONNECTIONS),
  ])
  return asFirst.length + asSecond.length < MAX_ACTIVE_FAMILY_CONNECTIONS
}

export async function getHearthRelationshipAuthorization(
  ctx: ConvexCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
): Promise<HearthRelationshipAuthorization> {
  if (firstUserId === secondUserId) return { allowed: true }

  const [firstUser, secondUser, connection] = await Promise.all([
    ctx.db.get(firstUserId),
    ctx.db.get(secondUserId),
    getActiveFamilyConnection(ctx, firstUserId, secondUserId),
  ])

  return evaluateHearthRelationship(
    firstUser ? getUserAgeBand(firstUser) : null,
    secondUser ? getUserAgeBand(secondUser) : null,
    connection,
    firstUserId,
    secondUserId,
  )
}

export async function assertUsersCanShareHearth(
  ctx: ConvexCtx,
  firstUserId: Id<'users'>,
  secondUserId: Id<'users'>,
): Promise<{ familyConnectionId?: Id<'familyConnections'> }> {
  const authorization = await getHearthRelationshipAuthorization(ctx, firstUserId, secondUserId)
  if (!authorization.allowed) {
    throwUserError(
      'Cross-age Hearth sharing requires an accepted family connection. Create a family invite link instead.',
    )
  }
  return { familyConnectionId: authorization.familyConnectionId }
}

/**
 * Authorize one existing participant grant. When a row was created through a
 * family connection, that exact connection must still be active even if the
 * two accounts later enter the same age band. This makes revocation durable.
 */
export async function isHearthParticipantAuthorized(
  ctx: ConvexCtx,
  ownerId: Id<'users'>,
  participantId: Id<'users'>,
  familyConnectionId?: Id<'familyConnections'>,
): Promise<boolean> {
  if (ownerId === participantId) return true

  const [owner, participant, connection] = await Promise.all([
    ctx.db.get(ownerId),
    ctx.db.get(participantId),
    familyConnectionId ? ctx.db.get(familyConnectionId) : null,
  ])
  return evaluateHearthParticipantGrant(
    owner ? getUserAgeBand(owner) : null,
    participant ? getUserAgeBand(participant) : null,
    connection,
    ownerId,
    participantId,
    familyConnectionId,
  )
}
