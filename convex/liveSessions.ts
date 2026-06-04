import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { query } from './_generated/server'
import { auth } from './auth'
import { isCampReadableStatus, requiresActiveMembershipForVisibility } from './campLifecycle'

async function getVisibleCampIds(ctx: QueryCtx, userId: Id<'users'> | null) {
  if (!userId) {
    return new Set<Id<'camps'>>()
  }

  const memberships = await ctx.db
    .query('campMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId).eq('status', 'active'))
    .collect()

  return new Set(memberships.map((membership) => membership.campId))
}

async function canViewBondfire(ctx: QueryCtx, bondfire: Doc<'bondfires'>) {
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    return false
  }
  if (!bondfire.campId) {
    return true
  }

  const camp = await ctx.db.get(bondfire.campId)
  if (!camp || !isCampReadableStatus(camp.status)) {
    return false
  }
  if (!requiresActiveMembershipForVisibility(camp)) {
    return true
  }

  const userId = await auth.getUserId(ctx)
  const memberCampIds = await getVisibleCampIds(ctx, userId)
  return memberCampIds.has(camp._id)
}

export const getByBondfireId = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire?.liveSessionId) {
      return null
    }
    if (!(await canViewBondfire(ctx, bondfire))) {
      return null
    }

    return await ctx.db.get(bondfire.liveSessionId)
  },
})

export const listMyActive = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const sessions = await ctx.db
      .query('liveSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(20)

    return sessions.filter((session) =>
      ['created', 'starting', 'live', 'ending'].includes(session.status),
    )
  },
})
