/**
 * Backend Entitlements — centralized subscription-tier enforcement.
 *
 * Every server-side authorization check that depends on the user's active
 * subscription tier should route through helpers defined in this module.
 * Individual mutations and queries should NOT duplicate tier-ranking logic
 * or inline ad-hoc subscription queries.
 *
 * Tier model (Phase 2 launch):
 *   free     — browse, join, respond, bookmark; cannot create Bondfires or own a private camp
 *   plus     — create Bondfires in public camps, own ONE private camp, 30-min video limit,
 *              private camp videos retained for 1 month
 *   premium  — plus perks + unlimited private-camp video retention, 30-min video limit
 *   pro      — premium perks + create/manage up to 3 public camps plus verified add-ons,
 *              unlimited video length, analytics, custom camp branding
 */

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

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

/** Maximum video duration (ms) for non-Pro tiers. Pro has no limit. */
export const TIER_MAX_VIDEO_DURATION_MS = 30 * 60 * 1000 // 30 minutes

/** Private-camp video retention window for Plus users (30 days). */
export const PLUS_PRIVATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Maximum active private camps a Plus/Premium user may own. */
export const MAX_PRIVATE_CAMPS_FOR_NON_PRO = 1

/** Maximum public camps a Pro user may own/manage. */
export const MAX_PUBLIC_CAMPS_FOR_PRO = 3

/** Additional public-camp capacity granted by one verified Pro extra-camp add-on. */
export const PRO_EXTRA_PUBLIC_CAMPS_PER_ADD_ON = 1

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

/**
 * Returns the number of active, verified Pro extra-camp add-ons for a user.
 *
 * Client-submitted pending store receipts are intentionally ignored here. Store
 * validation must mark an add-on `active`/`trialing` and `verified` before it
 * can expand a user's camp allowance.
 */
export async function getActiveProExtraPublicCampAddOnCount(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<number> {
  const now = Date.now()
  const addOns = await ctx.db
    .query('subscriptionAddOns')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  return addOns.filter(
    (addOn) =>
      addOn.type === 'pro_extra_public_camp' &&
      addOn.verificationStatus === 'verified' &&
      (addOn.status === 'active' || addOn.status === 'trialing') &&
      (!addOn.currentPeriodEnd || addOn.currentPeriodEnd > now),
  ).length
}

/**
 * Returns the current public-camp allowance for a Pro user, including verified
 * extra-camp add-ons. Non-Pro users have no public-camp creation allowance.
 */
export async function getPublicCampLimit(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<number> {
  const tier = await getActiveSubscriptionTier(ctx, userId)
  if (TIER_RANK[tier] < TIER_RANK.pro) {
    return 0
  }

  const extraCampAddOns = await getActiveProExtraPublicCampAddOnCount(ctx, userId)
  return MAX_PUBLIC_CAMPS_FOR_PRO + extraCampAddOns * PRO_EXTRA_PUBLIC_CAMPS_PER_ADD_ON
}

/**
 * Returns the tier to use for entitlement checks.
 *
 * Reviewer accounts are treated as Pro even when they do not have a real
 * paid subscription, so app review can exercise gated flows.
 */
export async function getEntitlementSubscriptionTier(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (user?.isReviewerAccount) {
    return 'pro'
  }

  return await getActiveSubscriptionTier(ctx, userId)
}

/**
 * Returns whether the user is at or above the given minimum tier.
 *
 * Free users that are reviewer accounts (isReviewerAccount === true) are
 * treated as Pro so that App Store / Google Play reviewers can exercise
 * every entitlement without requiring a real purchase.
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
 * Pro has no limit (returns undefined); all other tiers are capped at
 * 30 minutes.
 */
export function getTierMaxVideoDurationMs(tier: SubscriptionTier): number | undefined {
  if (TIER_RANK[tier] >= TIER_RANK.pro) {
    return undefined
  }

  return TIER_MAX_VIDEO_DURATION_MS
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
  if (camp.visibility !== 'private' || !camp.ownerId) {
    return undefined
  }

  const ownerTier = await getActiveSubscriptionTier(ctx, camp.ownerId)
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
    throw new Error('User not found')
  }

  // Reviewer accounts can always create private camps.
  if (user.isReviewerAccount) {
    return 'pro'
  }

  const tier = await getActiveSubscriptionTier(ctx, userId)

  if (!tierCanOwnPrivateCamp(tier)) {
    throw new Error('Private camps require Plus, Premium, or Pro')
  }

  // Plus and Premium users may own at most one private camp.
  if (TIER_RANK[tier] < TIER_RANK.pro) {
    const existingPrivateCamps = await ctx.db
      .query('camps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .filter((q) =>
        q.and(q.eq(q.field('visibility'), 'private'), q.eq(q.field('status'), 'active')),
      )
      .collect()

    if (existingPrivateCamps.length >= MAX_PRIVATE_CAMPS_FOR_NON_PRO) {
      throw new Error('You already have an active private camp')
    }
  }

  return tier
}

/**
 * Asserts that the user is allowed to create/manage a public camp.
 *
 * Currently only Pro users (or reviewer accounts) may create public camps.
 *
 * Throws with a user-facing message when the user lacks Pro entitlements.
 */
export async function assertCanCreatePublicCamp(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (!user) {
    throw new Error('User not found')
  }

  if (user.isReviewerAccount) {
    return 'pro'
  }

  const tier = await getActiveSubscriptionTier(ctx, userId)

  if (TIER_RANK[tier] < TIER_RANK.pro) {
    throw new Error('Creating public camps requires a Pro subscription')
  }

  // Pro users may own at most the base Pro allowance plus verified add-ons.
  const publicCampLimit = await getPublicCampLimit(ctx, userId)
  const existingPublicCamps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .filter((q) => q.and(q.eq(q.field('visibility'), 'public'), q.eq(q.field('status'), 'active')))
    .collect()

  if (existingPublicCamps.length >= publicCampLimit) {
    throw new Error(`You have reached the limit of ${publicCampLimit} public camps`)
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
 * independent of the UI paywall.  Reviewer accounts bypass this check.
 */
export async function assertCanCreateBondfire(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const user = await ctx.db.get(userId)
  if (!user) {
    throw new Error('User not found')
  }

  if (user.isReviewerAccount) {
    return 'pro'
  }

  const tier = await getActiveSubscriptionTier(ctx, userId)

  if (!tierCanCreateBondfires(tier)) {
    throw new Error(
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
 * the cap.  Pro users have no cap.  Reviewer accounts bypass this check.
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

  const user = await ctx.db.get(userId)
  if (user?.isReviewerAccount) {
    return
  }

  const tier = await getActiveSubscriptionTier(ctx, userId)
  const maxDurationMs = getTierMaxVideoDurationMs(tier)

  if (maxDurationMs !== undefined && durationMs > maxDurationMs) {
    const maxMinutes = Math.round(maxDurationMs / 60000)
    throw new Error(`Videos longer than ${maxMinutes} minutes require a Pro subscription`)
  }
}
