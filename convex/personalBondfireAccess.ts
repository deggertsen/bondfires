import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { assertUserAgeBand, getPersonalCampAgeBand, getUserAgeBand } from './agePolicy'
import { getEntitlementSubscriptionTier, PAID_TIERS, type SubscriptionTier } from './entitlements'
import { throwUserError } from './errors'
import { assertUsersCanShareHearth, isHearthParticipantAuthorized } from './familyRelationships'

type ConvexCtx = QueryCtx | MutationCtx

export async function getPersonalCampForOwner(
  ctx: ConvexCtx,
  owner: Pick<Doc<'users'>, '_id' | 'birthDate'>,
) {
  const ageBand = assertUserAgeBand(owner)
  const camps = await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', owner._id))
    .collect()
  return camps.find((camp) => getPersonalCampAgeBand(camp) === ageBand) ?? null
}

/** Plus: sparker + 1. Premium/Pro: sparker + 7. */
export function getPersonalBondfireParticipantCap(tier: SubscriptionTier): number {
  if (tier === 'premium' || tier === 'pro') {
    return 8
  }
  return 2
}

export async function getPersonalBondfireParticipant(
  ctx: ConvexCtx,
  args: {
    bondfireId: Id<'bondfires'>
    userId: Id<'users'>
  },
) {
  return await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_user', (q) =>
      q.eq('bondfireId', args.bondfireId).eq('userId', args.userId),
    )
    .first()
}

export async function getActivePersonalBondfireParticipantCount(
  ctx: ConvexCtx,
  bondfireId: Id<'bondfires'>,
): Promise<number> {
  const [bondfire, participants] = await Promise.all([
    ctx.db.get(bondfireId),
    ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId).eq('status', 'active'))
      .collect(),
  ])
  if (!bondfire) return 0

  const authorized = await Promise.all(
    participants.map((participant) =>
      isHearthParticipantAuthorized(
        ctx,
        bondfire.userId,
        participant.userId,
        participant.familyConnectionId,
      ),
    ),
  )
  return authorized.filter(Boolean).length
}

/**
 * Hearth visibility is participant-gated — an invite claim alone is not enough
 * to open the bondfire detail screen. Direct invites must land the recipient
 * in `personalBondfireParticipants` or they hit "This Bondfire isn't available".
 */
export async function ensureActivePersonalBondfireParticipant(
  ctx: MutationCtx,
  args: {
    bondfire: Doc<'bondfires'>
    userId: Id<'users'>
    errorAudience: 'owner' | 'invitee'
    /** Bind this participant to a newly accepted family invitation. */
    familyConnectionId?: Id<'familyConnections'>
  },
): Promise<{ added: boolean }> {
  if (!args.bondfire.personalCampId) {
    return { added: false }
  }

  const [personalCamp, ownerTier, owner, participantUser] = await Promise.all([
    ctx.db.get(args.bondfire.personalCampId),
    getEntitlementSubscriptionTier(ctx, args.bondfire.userId),
    ctx.db.get(args.bondfire.userId),
    ctx.db.get(args.userId),
  ])
  if (!personalCamp || personalCamp.status !== 'active' || !PAID_TIERS.includes(ownerTier)) {
    if (args.errorAudience === 'owner') {
      throwUserError('Your hearth is currently unavailable.')
    }
    throwUserError('This fire is unavailable.')
  }
  if (
    !owner ||
    !participantUser ||
    getUserAgeBand(owner) !== getPersonalCampAgeBand(personalCamp)
  ) {
    throwUserError(
      args.errorAudience === 'owner'
        ? 'Your Hearth age group is unavailable.'
        : 'This fire is unavailable.',
    )
  }
  let participantFamilyConnectionId = args.familyConnectionId
  if (participantFamilyConnectionId) {
    if (
      !(await isHearthParticipantAuthorized(
        ctx,
        owner._id,
        participantUser._id,
        participantFamilyConnectionId,
      ))
    ) {
      throwUserError('This family connection is no longer active.')
    }
  } else {
    const authorization = await assertUsersCanShareHearth(ctx, owner._id, participantUser._id)
    // Same-age peers have no connection id. Existing cross-age family members
    // receive the currently active grant.
    participantFamilyConnectionId = authorization.familyConnectionId
  }

  const existing = await getPersonalBondfireParticipant(ctx, {
    bondfireId: args.bondfire._id,
    userId: args.userId,
  })
  const existingIsAuthorized =
    existing?.status === 'active' &&
    (await isHearthParticipantAuthorized(
      ctx,
      owner._id,
      participantUser._id,
      existing.familyConnectionId,
    ))
  // Ordinary invitations preserve a valid family-bound grant. Explicitly
  // accepting a family invitation binds the row to that grant so it remains
  // authorized if either person's age band later changes.
  if (
    existingIsAuthorized &&
    (args.familyConnectionId === undefined ||
      existing.familyConnectionId === participantFamilyConnectionId)
  ) {
    return { added: false }
  }

  // Touch the bondfire row first so concurrent invite mutations conflict and
  // retry instead of both reading the same under-cap count.
  const now = Date.now()
  await ctx.db.patch(args.bondfire._id, { updatedAt: now })

  const cap = getPersonalBondfireParticipantCap(ownerTier)
  const activeCount = await getActivePersonalBondfireParticipantCount(ctx, args.bondfire._id)
  // Rebinding an already-authorized participant does not consume a new slot.
  if (!existingIsAuthorized && activeCount >= cap) {
    if (args.errorAudience === 'owner' && ownerTier === 'plus') {
      throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
    }
    throwUserError('This fire is full.')
  }

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'active',
      joinedAt: existingIsAuthorized ? existing.joinedAt : now,
      leftAt: undefined,
      removedAt: undefined,
      removedBy: undefined,
      familyConnectionId: participantFamilyConnectionId,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId: args.bondfire._id,
      userId: args.userId,
      status: 'active',
      familyConnectionId: participantFamilyConnectionId,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  }

  return { added: !existingIsAuthorized }
}

export async function isActivePersonalBondfireParticipant(
  ctx: ConvexCtx,
  args: {
    bondfire: Doc<'bondfires'>
    userId: Id<'users'>
  },
) {
  if (args.bondfire.userId === args.userId) {
    return true
  }

  const participant = await getPersonalBondfireParticipant(ctx, {
    bondfireId: args.bondfire._id,
    userId: args.userId,
  })

  return (
    participant?.status === 'active' &&
    (await isHearthParticipantAuthorized(
      ctx,
      args.bondfire.userId,
      args.userId,
      participant.familyConnectionId,
    ))
  )
}

export async function isPersonalBondfireActive(ctx: ConvexCtx, bondfire: Doc<'bondfires'>) {
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    return false
  }

  if (!bondfire.personalCampId) {
    return false
  }

  const personalCamp = await ctx.db.get(bondfire.personalCampId)
  return personalCamp?.status === 'active'
}

export async function canViewPersonalBondfire(
  ctx: ConvexCtx,
  args: {
    bondfire: Doc<'bondfires'>
    userId: Id<'users'> | null
  },
) {
  if (!args.userId || !(await isPersonalBondfireActive(ctx, args.bondfire))) {
    return false
  }

  const [personalCamp, owner] = await Promise.all([
    args.bondfire.personalCampId ? ctx.db.get(args.bondfire.personalCampId) : null,
    ctx.db.get(args.bondfire.userId),
  ])
  if (!personalCamp || !owner) return false
  if (getUserAgeBand(owner) !== getPersonalCampAgeBand(personalCamp)) return false

  return await isActivePersonalBondfireParticipant(ctx, {
    bondfire: args.bondfire,
    userId: args.userId,
  })
}

export async function assertCanRespondToPersonalBondfire(
  ctx: ConvexCtx,
  args: {
    bondfire: Doc<'bondfires'>
    userId: Id<'users'>
  },
) {
  if (!(await isPersonalBondfireActive(ctx, args.bondfire))) {
    throwUserError('This fire is unavailable.')
  }

  if (!(await canViewPersonalBondfire(ctx, { bondfire: args.bondfire, userId: args.userId }))) {
    throwUserError('Join this fire before responding.')
  }
}
