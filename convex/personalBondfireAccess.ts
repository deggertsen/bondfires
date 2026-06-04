import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { throwUserError } from './errors'

type ConvexCtx = QueryCtx | MutationCtx

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
