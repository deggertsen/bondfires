import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { getEntitlementSubscriptionTier, PAID_TIERS, type SubscriptionTier } from './entitlements'
import { throwUserError } from './errors'

type ConvexCtx = QueryCtx | MutationCtx

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
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId).eq('status', 'active'))
    .collect()

  return participants.length
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
  },
): Promise<{ added: boolean }> {
  if (!args.bondfire.personalCampId) {
    return { added: false }
  }

  const [personalCamp, ownerTier] = await Promise.all([
    ctx.db.get(args.bondfire.personalCampId),
    getEntitlementSubscriptionTier(ctx, args.bondfire.userId),
  ])
  if (!personalCamp || personalCamp.status !== 'active' || !PAID_TIERS.includes(ownerTier)) {
    if (args.errorAudience === 'owner') {
      throwUserError('Your hearth is currently unavailable.')
    }
    throwUserError('This fire is unavailable.')
  }

  const existing = await getPersonalBondfireParticipant(ctx, {
    bondfireId: args.bondfire._id,
    userId: args.userId,
  })
  if (existing?.status === 'active') {
    return { added: false }
  }

  // Touch the bondfire row first so concurrent invite mutations conflict and
  // retry instead of both reading the same under-cap count.
  const now = Date.now()
  await ctx.db.patch(args.bondfire._id, { updatedAt: now })

  const cap = getPersonalBondfireParticipantCap(ownerTier)
  const activeCount = await getActivePersonalBondfireParticipantCount(ctx, args.bondfire._id)
  if (activeCount >= cap) {
    if (args.errorAudience === 'owner' && ownerTier === 'plus') {
      throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
    }
    throwUserError('This fire is full.')
  }

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'active',
      joinedAt: now,
      leftAt: undefined,
      removedAt: undefined,
      removedBy: undefined,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId: args.bondfire._id,
      userId: args.userId,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  }

  return { added: true }
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

  return participant?.status === 'active'
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

  if (
    !(await isActivePersonalBondfireParticipant(ctx, {
      bondfire: args.bondfire,
      userId: args.userId,
    }))
  ) {
    throwUserError('Join this fire before responding.')
  }
}
