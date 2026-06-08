/**
 * Backend Entitlements — centralized subscription-tier enforcement.
 *
 * Every server-side authorization check that depends on the user's active
 * subscription tier should route through helpers defined in this module.
 * Individual mutations and queries should NOT duplicate tier-ranking logic
 * or inline ad-hoc subscription queries.
 *
 * Tier model (Phase 2 launch):
 *   free     — browse, join, respond up to 5 min, bookmark; cannot create Bondfires
 *              or own a private camp
 *   plus     — create Bondfires in public camps, own ONE private camp, 15-min video limit,
 *              private camp videos retained for 1 month
 *   premium  — plus perks + unlimited private-camp video retention, 30-min video limit
 *   pro      — premium perks + create/manage up to 3 public camps plus verified add-ons,
 *              unlimited video length, analytics, custom camp branding
 */

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { burnKindlingForCamp, computeKindlingBalance } from './campKindling'
import { throwUserError } from './errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Numeric rank for tier comparison. Higher = more capabilities. */
export const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  pro: 3,
}

/** Tiers that have paid for at least Plus-level access. */
export const PAID_TIERS: readonly SubscriptionTier[] = ['plus', 'premium', 'pro']

/** Maximum video duration (ms) for Free tier members responding to Bondfires. */
export const FREE_MAX_VIDEO_DURATION_MS = 5 * 60 * 1000 // 5 minutes

/** Maximum video duration (ms) for Plus tier members. */
export const PLUS_MAX_VIDEO_DURATION_MS = 15 * 60 * 1000 // 15 minutes

/** Maximum video duration (ms) for Premium tier members. */
export const PREMIUM_MAX_VIDEO_DURATION_MS = 30 * 60 * 1000 // 30 minutes

/** Private-camp video retention window for Plus users (30 days). */
export const PLUS_PRIVATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Maximum active private camps a Plus/Premium user may own. */
export const MAX_PRIVATE_CAMPS_FOR_NON_PRO = 1

/** Reclaim window: owners have this many milliseconds to resubscribe and reclaim
 * frozen camps before they become eligible for transfer to another Pro member. */
export const CAMP_RECLAIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Returns the highest active subscription tier for the given user.
 *
 * An active subscription is one with status `active` or `trialing` that
 * has not reached its `currentPeriodEnd` (if set).  Expired, past_due,
 * and canceled subscriptions are ignored, which means the tier gracefully
 * downgrades to "free" when a subscription lapses.
 */
export async function getActiveSubscriptionTier(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const now = Date.now()
  const subscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  const activeSubscriptions = subscriptions.filter(
    (sub) =>
      sub.verificationStatus === 'verified' &&
      (sub.status === 'active' || sub.status === 'trialing') &&
      (!sub.currentPeriodEnd || sub.currentPeriodEnd > now),
  )

  return activeSubscriptions.reduce<SubscriptionTier>(
    (highest, sub) => (TIER_RANK[sub.tier] > TIER_RANK[highest] ? sub.tier : highest),
    'free',
  )
}

/** Base camp limits by tier. Pro public camp limit is governed by kindling balance, not a hard cap. */
export const TIER_CAMP_LIMITS: Record<
  SubscriptionTier,
  { publicCamps?: number; privateCamps: number }
> = {
  free: { privateCamps: 0 },
  plus: { privateCamps: 1 },
  premium: { privateCamps: 1 },
  pro: { privateCamps: 1 },
  // Pro public camps are limited by kindling balance only — no hard cap.
}

/**
 * Returns the tier to use for entitlement checks.
 *
 * When a user has an admin-forced tier override (`forcedTier`), it takes
 * precedence over any store-based subscription.  This allows admins to
 * grant specific tiers for QA and app review without requiring a real
 * purchase.
 */
export async function getEntitlementSubscriptionTier(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (user?.forcedTier) {
    return user.forcedTier
  }

  return await getActiveSubscriptionTier(ctx, userId)
}

/**
 * Returns whether the user is at or above the given minimum tier.
 *
 * Admin-forced tier overrides (forcedTier) are respected through
 * getEntitlementSubscriptionTier.
 */
export async function userHasTier(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  minimumTier: SubscriptionTier,
): Promise<boolean> {
  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  return TIER_RANK[tier] >= TIER_RANK[minimumTier]
}

// ---------------------------------------------------------------------------
// Entitlement enforcement
// ---------------------------------------------------------------------------

/**
 * Whether a user with the given tier is allowed to create Bondfires.
 *
 * Free users cannot create Bondfires at all.  This is enforced server-side
 * so that bypassing the UI paywall cannot create unauthorized content.
 */
export function tierCanCreateBondfires(tier: SubscriptionTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.plus
}

/**
 * Maximum video duration in milliseconds allowed for the given tier.
 * - Free: 5 minutes for responses; Bondfire creation is blocked separately
 * - Plus: 15 minutes
 * - Premium: 30 minutes
 * - Pro: no limit (returns undefined)
 */
export function getTierMaxVideoDurationMs(tier: SubscriptionTier): number | undefined {
  switch (tier) {
    case 'free':
      return FREE_MAX_VIDEO_DURATION_MS
    case 'plus':
      return PLUS_MAX_VIDEO_DURATION_MS
    case 'premium':
      return PREMIUM_MAX_VIDEO_DURATION_MS
    case 'pro':
      return undefined
  }
}

function getVideoDurationUpgradeRequirement(tier: SubscriptionTier): string {
  switch (tier) {
    case 'free':
    case 'plus':
      return 'Premium or Pro'
    case 'premium':
    case 'pro':
      return 'Pro'
  }
}

/**
 * Whether a user with the given tier may own/create a private camp.
 *
 * Plus, Premium, and Pro users may own private camps.
 * Free users cannot.
 */
export function tierCanOwnPrivateCamp(tier: SubscriptionTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.plus
}

/**
 * Returns the expiresAt timestamp for a new bondfire created in a private
 * camp. Plus-tier owners have a 30-day retention window; Premium and Pro
 * owners have unlimited retention (returns undefined).
 *
 * The camp MUST be a private camp with an owner; callers should validate
 * that first.
 */
export async function getPrivateCampExpiresAt(
  ctx: QueryCtx | MutationCtx,
  camp: Doc<'camps'>,
  now: number,
): Promise<number | undefined> {
  if (!camp.ownerId || camp.access !== 'invite') {
    return undefined
  }

  const ownerTier = await getEntitlementSubscriptionTier(ctx, camp.ownerId)
  if (ownerTier === 'plus') {
    return now + PLUS_PRIVATE_RETENTION_MS
  }

  // Premium and Pro owners have unlimited retention.
  return undefined
}

// ---------------------------------------------------------------------------
// Camp-creation guards
// ---------------------------------------------------------------------------

/**
 * Asserts that the user is allowed to create a private camp.
 *
 * Throws with a user-facing message when:
 *  - The user's tier is below Plus
 *  - A Plus or Premium user already owns the maximum allowed private camps
 *  - A Pro user has hit the private-camp limit (if Pro-only rules apply)
 *
 * Reviewer accounts bypass all limits.
 */
export async function assertCanCreatePrivateCamp(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  // Admin-forced tier overrides are respected through
  // getEntitlementSubscriptionTier — no separate reviewer check needed.
  const tier = await getEntitlementSubscriptionTier(ctx, userId)

  if (!tierCanOwnPrivateCamp(tier)) {
    throwUserError('Private camps require Plus, Premium, or Pro')
  }

  // Plus and Premium users may own at most one private camp.
  if (TIER_RANK[tier] < TIER_RANK.pro) {
    const existingPrivateCamps = await ctx.db
      .query('camps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .collect()
    const activePrivateCampCount = existingPrivateCamps.filter(
      (camp) => camp.access === 'invite' && (camp.status === 'active' || camp.status === 'frozen'),
    ).length

    if (activePrivateCampCount >= MAX_PRIVATE_CAMPS_FOR_NON_PRO) {
      throwUserError('You already have an active private camp')
    }
  }

  return tier
}

/**
 * Asserts that the user is allowed to create/manage a public camp.
 *
 * Currently only Pro users may create public camps.
 * Admin-forced tier overrides are respected through
 * getEntitlementSubscriptionTier.
 * Throws with a user-facing message when the user lacks Pro entitlements.
 */
export async function assertCanCreatePublicCamp(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  // Admin-forced tier overrides are respected through
  // getEntitlementSubscriptionTier.
  const tier = await getEntitlementSubscriptionTier(ctx, userId)

  if (TIER_RANK[tier] < TIER_RANK.pro) {
    throwUserError('Creating public camps requires a Pro subscription')
  }

  // Public camp creation is limited by kindling balance, not a hard count cap.
  // The calling mutation (createPublicCamp) will also call burnKindling
  // which enforces balance ≥ 1. We do a lightweight balance check here to
  // give an earlier, clearer error message.
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  const balance = transactions.reduce((sum, tx) => sum + tx.amount, 0)

  if (balance < 1) {
    throwUserError('You need at least 1 kindling to create a public camp')
  }

  return tier
}

// ---------------------------------------------------------------------------
// Bondfire creation guard
// ---------------------------------------------------------------------------

/**
 * Asserts that the user may create a Bondfire.
 *
 * Free users cannot create Bondfires.  This is a server-side enforcement
 * independent of the UI paywall.  Admin-forced tier overrides are respected
 * through getEntitlementSubscriptionTier.
 */
export async function assertCanCreateBondfire(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  // Admin-forced tier overrides are respected through
  // getEntitlementSubscriptionTier.
  const tier = await getEntitlementSubscriptionTier(ctx, userId)

  if (!tierCanCreateBondfires(tier)) {
    throwUserError(
      'Spark a Bondfire with Plus, Premium, or Pro. Your free membership includes watching and responding.',
    )
  }

  return tier
}

// ---------------------------------------------------------------------------
// Video duration enforcement
// ---------------------------------------------------------------------------

/**
 * Asserts that the given duration in milliseconds is within the user's
 * tier limit.  Throws with a user-facing error when the duration exceeds
 * the cap.  Pro users have no cap.  Admin-forced tier overrides are
 * respected through getEntitlementSubscriptionTier.
 *
 * Callers should pass a valid `userId` (already authenticated) and
 * `durationMs` (from Mux metadata or the upload request).
 */
export async function assertVideoDurationWithinTierLimit(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  durationMs: number | undefined,
): Promise<void> {
  if (durationMs === undefined || durationMs <= 0) {
    return
  }

  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  const maxDurationMs = getTierMaxVideoDurationMs(tier)

  if (maxDurationMs !== undefined && durationMs > maxDurationMs) {
    const maxMinutes = Math.round(maxDurationMs / 60000)
    const requiredTier = getVideoDurationUpgradeRequirement(tier)
    throwUserError(`Videos longer than ${maxMinutes} minutes require ${requiredTier}`)
  }
}

// ---------------------------------------------------------------------------
// Downgrade handling
// ---------------------------------------------------------------------------

async function getCampLimitsForTier(
  _ctx: QueryCtx | MutationCtx,
  _userId: Id<'users'>,
  tier: SubscriptionTier,
) {
  // For public camps: Pro has no hard cap — limited by kindling balance.
  // For private camps: limits are per TIER_CAMP_LIMITS.
  return {
    publicCamps: TIER_RANK[tier] >= TIER_RANK.pro ? Number.POSITIVE_INFINITY : 0,
    privateCamps: TIER_CAMP_LIMITS[tier].privateCamps,
  }
}

export async function freezeExcessOwnedCamps(
  ctx: MutationCtx,
  userId: Id<'users'>,
  tier: SubscriptionTier,
): Promise<{ campsFrozen: number }> {
  const now = Date.now()
  const limits = await getCampLimitsForTier(ctx, userId, tier)
  const userCamps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect()

  const activePublicCamps = userCamps
    .filter((camp) => camp.access !== 'invite' && camp.status === 'active')
    .sort((left, right) => left.createdAt - right.createdAt)
  const activePrivateCamps = userCamps
    .filter((camp) => camp.access === 'invite' && camp.status === 'active')
    .sort((left, right) => left.createdAt - right.createdAt)

  let campsFrozen = 0
  const excessCamps = [
    ...activePublicCamps.slice(limits.publicCamps),
    ...activePrivateCamps.slice(limits.privateCamps),
  ]

  for (const camp of excessCamps) {
    await ctx.db.patch(camp._id, {
      status: 'frozen',
      frozenAt: now,
      reclaimDeadline: now + CAMP_RECLAIM_WINDOW_MS,
      updatedAt: now,
    })
    campsFrozen++
  }

  return { campsFrozen }
}

/**
 * When a user's subscription tier changes, freeze excess camps and revoke
 * extra-camp add-ons if the user is no longer Pro.
 *
 * Called from subscription sync/verification after a tier change is detected.
 *
 * Rules:
 *  - If the user is no longer Pro, revoke all active extra_camp add-ons.
 *  - Freeze excess public camps that exceed the new tier's allowance.
 *  - Freeze excess private camps that exceed the new tier's allowance.
 *  - Frozen camps are NOT deleted. Existing members can still view, but no new
 *    videos can be recorded and no new members can join.
 */
export async function handleTierDowngrade(
  ctx: MutationCtx,
  userId: Id<'users'>,
  previousTier: SubscriptionTier,
  newTier: SubscriptionTier,
): Promise<{ campsFrozen: number }> {
  // Only act on actual downgrades
  if (TIER_RANK[newTier] >= TIER_RANK[previousTier]) {
    return { campsFrozen: 0 }
  }

  // No more add-ons to revoke — kindling is consumable.
  // Just freeze excess owned camps based on the new tier's limits.
  const { campsFrozen } = await freezeExcessOwnedCamps(ctx, userId, newTier)
  return { campsFrozen }
}

/**
 * Unfreeze camps when a user upgrades their subscription.
 *
 * Activates previously frozen camps up to the new tier's allowance.
 * Public camps are reactivated first (oldest first), then private camps.
 */
export async function handleTierUpgrade(
  ctx: MutationCtx,
  userId: Id<'users'>,
  previousTier: SubscriptionTier,
  newTier: SubscriptionTier,
): Promise<{ campsUnfrozen: number }> {
  // Only act on actual upgrades
  if (TIER_RANK[newTier] <= TIER_RANK[previousTier]) {
    return { campsUnfrozen: 0 }
  }

  const limits = TIER_CAMP_LIMITS[newTier]
  const userCamps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect()

  const activePrivateCamps = userCamps.filter((c) => c.access === 'invite' && c.status === 'active')
  const frozenCamps = userCamps
    .filter((c) => c.status === 'frozen')
    .sort((a, b) => a.createdAt - b.createdAt) // Oldest first

  let campsUnfrozen = 0
  const isPro = TIER_RANK[newTier] >= TIER_RANK.pro
  let privateSlotsLeft = limits.privateCamps - activePrivateCamps.length

  for (const camp of frozenCamps) {
    if (isPro) {
      // All Pro-created camps (public and private) consume kindling on reactivation.
      const { alreadyConsumed, insufficientKindling } = await burnKindlingForCamp(ctx, {
        userId,
        campId: camp._id,
      })
      // alreadyConsumed: same-month reactivation, kindling already paid this period.
      // insufficientKindling: no kindling available, skip this camp gracefully.
      if (alreadyConsumed || !insufficientKindling) {
        await ctx.db.patch(camp._id, {
          status: 'active',
          frozenAt: undefined,
          reclaimDeadline: undefined,
          updatedAt: Date.now(),
        })
        campsUnfrozen++
      }
    } else if (camp.access === 'invite' && privateSlotsLeft > 0) {
      await ctx.db.patch(camp._id, {
        status: 'active',
        frozenAt: undefined,
        reclaimDeadline: undefined,
        updatedAt: Date.now(),
      })
      privateSlotsLeft--
      campsUnfrozen++
    }
  }

  return { campsUnfrozen }
}

// ---------------------------------------------------------------------------
// Camp reclaim & transfer
// ---------------------------------------------------------------------------

/**
 * Reclaim frozen camps. Called when a former Pro user resubscribes (to Pro or
 * higher) within the 30-day reclaim window. Camps are unfrozen and the owner
 * is restored.
 */
export async function reclaimFrozenCamps(
  ctx: MutationCtx,
  userId: Id<'users'>,
  tier: SubscriptionTier,
): Promise<{ campsReclaimed: number }> {
  const now = Date.now()
  const limits = TIER_CAMP_LIMITS[tier]
  const frozenUserCamps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect()

  const eligibleFrozenCamps = frozenUserCamps
    .filter(
      (c) => c.status === 'frozen' && c.reclaimDeadline !== undefined && c.reclaimDeadline > now,
    )
    .sort((a, b) => (a.frozenAt ?? 0) - (b.frozenAt ?? 0)) // Oldest frozen first

  if (eligibleFrozenCamps.length === 0) {
    return { campsReclaimed: 0 }
  }

  const isPro = TIER_RANK[tier] >= TIER_RANK.pro
  const activePrivateCamps = frozenUserCamps.filter(
    (c) => c.access === 'invite' && c.status === 'active',
  )
  let privateSlotsLeft = limits.privateCamps - activePrivateCamps.length

  let campsReclaimed = 0

  for (const camp of eligibleFrozenCamps) {
    if (isPro) {
      // All Pro-created camps (public and private) consume kindling on reclaim.
      const { alreadyConsumed, insufficientKindling } = await burnKindlingForCamp(ctx, {
        userId,
        campId: camp._id,
      })
      if (alreadyConsumed || !insufficientKindling) {
        await ctx.db.patch(camp._id, {
          status: 'active',
          frozenAt: undefined,
          reclaimDeadline: undefined,
          updatedAt: now,
        })
        campsReclaimed++
      }
    } else if (camp.access === 'invite' && privateSlotsLeft > 0) {
      await ctx.db.patch(camp._id, {
        status: 'active',
        frozenAt: undefined,
        reclaimDeadline: undefined,
        updatedAt: now,
      })
      privateSlotsLeft--
      campsReclaimed++
    }
  }

  return { campsReclaimed }
}

/**
 * Process expired reclaim windows. After the 30-day reclaim deadline passes,
 * frozen camps become eligible for transfer to a Pro member already in the
 * camp. If no eligible Pro members exist, the camp is archived.
 *
 * Called periodically by a scheduled Convex function.
 */
export async function processExpiredReclaims(
  ctx: MutationCtx,
): Promise<{ campsTransferred: number; campsArchived: number }> {
  const now = Date.now()
  const expiredCamps = await ctx.db
    .query('camps')
    .filter((q) => q.and(q.eq(q.field('status'), 'frozen'), q.lte(q.field('reclaimDeadline'), now)))
    .collect()

  if (expiredCamps.length === 0) {
    return { campsTransferred: 0, campsArchived: 0 }
  }

  let campsTransferred = 0
  let campsArchived = 0

  for (const camp of expiredCamps) {
    if (!camp.ownerId) {
      await ctx.db.patch(camp._id, {
        status: 'archived',
        archivedAt: now,
        access: 'invite',
        frozenAt: undefined,
        reclaimDeadline: undefined,
        updatedAt: now,
      })
      campsArchived++
      continue
    }

    // Find eligible Pro members in the camp (not the current owner, active, Pro tier)
    const members = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status', (q) => q.eq('campId', camp._id).eq('status', 'active'))
      .collect()

    const eligibleMembers = members.filter(
      (m) => m.userId !== camp.ownerId && m.status !== 'banned',
    )
    const eligibleProMembers = []

    for (const member of eligibleMembers.sort(
      (left, right) => (left.joinedAt ?? left.createdAt) - (right.joinedAt ?? right.createdAt),
    )) {
      const memberTier = await getActiveSubscriptionTier(ctx, member.userId)
      if (TIER_RANK[memberTier] < TIER_RANK.pro) {
        continue
      }

      const kindlingBalance = await computeKindlingBalance(ctx, member.userId)

      if (kindlingBalance >= 1) {
        eligibleProMembers.push(member)
      }
    }

    if (eligibleProMembers.length === 0) {
      // No eligible member to transfer to — archive
      await ctx.db.patch(camp._id, {
        status: 'archived',
        archivedAt: now,
        access: 'invite',
        frozenAt: undefined,
        reclaimDeadline: undefined,
        updatedAt: now,
      })
      campsArchived++
      continue
    }

    // For now, assign to the first eligible Pro member.
    // A future enhancement could add a claim button in the UI.
    const newOwnerId = eligibleProMembers[0].userId

    // Consume kindling for the transferred camp (all camps now kindling-gated).
    await burnKindlingForCamp(ctx, { userId: newOwnerId, campId: camp._id })

    await ctx.db.patch(camp._id, {
      ownerId: newOwnerId,
      status: 'active',
      frozenAt: undefined,
      reclaimDeadline: undefined,
      updatedAt: now,
    })

    // Update camp member role for new owner
    const newOwnerMembership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', newOwnerId).eq('campId', camp._id))
      .unique()

    if (newOwnerMembership) {
      await ctx.db.patch(newOwnerMembership._id, {
        role: 'owner',
        updatedAt: now,
      })
    }

    // Demote old owner to member or remove
    const previousOwnerId = camp.ownerId
    const oldOwnerMembership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', previousOwnerId).eq('campId', camp._id))
      .unique()

    if (oldOwnerMembership) {
      await ctx.db.patch(oldOwnerMembership._id, {
        role: 'member',
        updatedAt: now,
      })
    }

    campsTransferred++
  }

  return { campsTransferred, campsArchived }
}
