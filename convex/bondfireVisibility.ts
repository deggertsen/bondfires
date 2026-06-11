import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { isCampReadableStatus, requiresActiveMembershipForVisibility } from './campLifecycle'
import { computeVisibility } from './camps'
import type { SubscriptionTier } from './entitlements'
import { getEntitlementSubscriptionTier } from './entitlements'
import { canViewPersonalBondfire } from './personalBondfireAccess'

/**
 * Per-request viewer context for bondfire visibility checks.
 *
 * Build it once per query via [buildViewerVisibilityContext] and reuse it for
 * every bondfire in the result set — visibility checks need the viewer's user
 * doc, entitlement tier, and camp memberships, and fetching those per bondfire
 * turns a feed query into an N+1 storm.
 */
export type ViewerVisibilityContext = {
  userId: Id<'users'> | null
  user: Doc<'users'> | null
  tier: SubscriptionTier
  memberCampIds: Set<Id<'camps'>>
  /**
   * Camps already requested during this query, keyed by id. Stores promises
   * so concurrent visibility checks (Promise.all over a feed) dedupe too.
   */
  campCache: Map<Id<'camps'>, Promise<Doc<'camps'> | null>>
}

export async function buildViewerVisibilityContext(
  ctx: QueryCtx,
  userId: Id<'users'> | null,
): Promise<ViewerVisibilityContext> {
  if (!userId) {
    return {
      userId: null,
      user: null,
      tier: 'free',
      memberCampIds: new Set(),
      campCache: new Map(),
    }
  }

  const [user, tier, memberships] = await Promise.all([
    ctx.db.get(userId),
    getEntitlementSubscriptionTier(ctx, userId),
    ctx.db
      .query('campMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId).eq('status', 'active'))
      .collect(),
  ])

  return {
    userId,
    user,
    tier,
    memberCampIds: new Set(memberships.map((membership) => membership.campId)),
    campCache: new Map(),
  }
}

function getCampCached(
  ctx: QueryCtx,
  viewer: ViewerVisibilityContext,
  campId: Id<'camps'>,
): Promise<Doc<'camps'> | null> {
  let campPromise = viewer.campCache.get(campId)
  if (!campPromise) {
    campPromise = ctx.db.get(campId)
    viewer.campCache.set(campId, campPromise)
  }
  return campPromise
}

/**
 * Whether the contents of a camp (bondfires, responses, threads) are visible
 * to the viewer.
 *
 * Rules, in order:
 * - Camps in unreadable statuses hide their content.
 * - Invite-only (by access or rule), frozen, grace, and archived camps
 *   require active membership.
 * - Active members always see their camps' content.
 * - Non-members get the same gender/age/tier rules as the camp list
 *   (hide-mode rules make the camp's content invisible).
 */
export function isCampContentVisibleToViewer(
  camp: Doc<'camps'>,
  viewer: ViewerVisibilityContext,
): boolean {
  if (!isCampReadableStatus(camp.status)) {
    return false
  }

  if (requiresActiveMembershipForVisibility(camp)) {
    return viewer.memberCampIds.has(camp._id)
  }

  if (viewer.memberCampIds.has(camp._id)) {
    return true
  }

  return computeVisibility(
    {
      gender: viewer.user?.gender ?? 'other',
      tier: viewer.tier,
      birthDate: viewer.user?.birthDate,
    },
    camp,
  ).visible
}

/**
 * Single source of truth for whether a bondfire is visible to a viewer.
 *
 * - Expired bondfires (private camp retention) are never visible.
 * - Personal camp bondfires delegate to canViewPersonalBondfire.
 * - Campless bondfires are public.
 * - Camp bondfires follow isCampContentVisibleToViewer.
 */
export async function isBondfireVisibleToViewer(
  ctx: QueryCtx,
  bondfire: Doc<'bondfires'>,
  viewer: ViewerVisibilityContext,
): Promise<boolean> {
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    return false
  }

  if (bondfire.personalCampId) {
    return await canViewPersonalBondfire(ctx, { bondfire, userId: viewer.userId })
  }

  if (!bondfire.campId) {
    return true
  }

  const camp = await getCampCached(ctx, viewer, bondfire.campId)
  if (!camp) {
    return false
  }

  return isCampContentVisibleToViewer(camp, viewer)
}

/** Filter a list of bondfires down to those visible to the viewer. */
export async function filterVisibleBondfiresForViewer(
  ctx: QueryCtx,
  bondfires: Doc<'bondfires'>[],
  viewer: ViewerVisibilityContext,
): Promise<Doc<'bondfires'>[]> {
  const visibility = await Promise.all(
    bondfires.map((bondfire) => isBondfireVisibleToViewer(ctx, bondfire, viewer)),
  )
  return bondfires.filter((_, index) => visibility[index])
}
