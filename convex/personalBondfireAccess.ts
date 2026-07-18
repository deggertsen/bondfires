import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { getEntitlementSubscriptionTier } from './entitlements'
import { throwUserError } from './errors'

type ConvexCtx = QueryCtx | MutationCtx

/** Plus: sparker + 1. Premium/Pro: sparker + 7. */
function getParticipantCap(tier: string): number {
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

async function getActiveParticipantCount(
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
  },
): Promise<{ added: boolean }> {
  if (!args.bondfire.personalCampId) {
    return { added: false }
  }

  const existing = await getPersonalBondfireParticipant(ctx, {
    bondfireId: args.bondfire._id,
    userId: args.userId,
  })
  if (existing?.status === 'active') {
    return { added: false }
  }

  const ownerTiers = await getEntitlementSubscriptionTier(ctx, args.bondfire.userId)
  const cap = getParticipantCap(ownerTiers)
  const activeCount = await getActiveParticipantCount(ctx, args.bondfire._id)
  if (activeCount >= cap) {
    if (ownerTiers === 'plus') {
      throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
    }
    throwUserError('This fire is full.')
  }

  const now = Date.now()
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
