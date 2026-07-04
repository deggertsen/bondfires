import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

export type BondfireBadge = 'sparked' | 'invited' | 'kindled'

type BadgeableBondfire = Pick<Doc<'bondfires'>, '_id' | 'campId' | 'videoCount'> & {
  /**
   * Whether the viewer has unseen activity in this bondfire (computed for My Fires
   * thread summaries). When true and the viewer wasn't just invited, the bondfire
   * is badged 'kindled' — the fire is growing with responses they haven't watched.
   */
  unread?: boolean
}

export async function addInviteBadgesToBondfires<T extends BadgeableBondfire>(
  ctx: QueryCtx,
  userId: Id<'users'> | null,
  bondfires: T[],
): Promise<Array<T & { badge: BondfireBadge | null }>> {
  if (!userId || bondfires.length === 0) {
    return bondfires.map((bondfire) => ({ ...bondfire, badge: null }))
  }

  const bondfireIds = new Set(bondfires.map((bondfire) => bondfire._id))
  const unseenClaims = await ctx.db
    .query('inviteClaims')
    .withIndex('by_claimer_unseen', (q) =>
      q.eq('claimerId', userId).eq('seen', false).eq('dismissed', false),
    )
    .collect()

  const invitedBondfireIds = new Set(
    unseenClaims
      .map((claim) => claim.bondfireId)
      .filter((bondfireId): bondfireId is Id<'bondfires'> =>
        bondfireId ? bondfireIds.has(bondfireId) : false,
      ),
  )

  const campIds = [
    ...new Set(
      bondfires
        .map((bondfire) => bondfire.campId)
        .filter((campId): campId is Id<'camps'> => campId !== undefined),
    ),
  ]
  const activeCampIds = new Set<Id<'camps'>>()
  for (const campId of campIds) {
    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .unique()
    if (membership?.status === 'active') {
      activeCampIds.add(campId)
    }
  }

  return bondfires.map((bondfire) => {
    const badge: BondfireBadge | null = invitedBondfireIds.has(bondfire._id)
      ? 'invited'
      : bondfire.unread === true
        ? 'kindled'
        : bondfire.campId && activeCampIds.has(bondfire.campId) && bondfire.videoCount === 0
          ? 'sparked'
          : null

    return { ...bondfire, badge }
  })
}
