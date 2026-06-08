/**
 * Camp Kindling Management — monthly kindling consumption system.
 *
 * Every active Pro-created camp (public or private) consumes 1 kindling per month.
 * Pro users get 3 free kindling per month on their billing date. Extra kindling
 * packs are purchasable as consumable IAPs. All kindling movements are recorded
 * in the existing immutable ledger (campSlotTransactions table) and balance is
 * always computed, never stored.
 *
 * Balance formula: SUM(positive amounts) − SUM(negative amounts)
 * Balance can NEVER go negative — all consuming operations throw hard errors.
 */

import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery, query } from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, TIER_RANK } from './entitlements'
import { throwUserError } from './errors'

const kindlingCreditMetadataValidator = v.object({
  consumablePurchaseId: v.id('consumablePurchases'),
  storeProductId: v.string(),
  storeTransactionId: v.optional(v.string()),
  storeOriginalTransactionId: v.optional(v.string()),
  storePurchaseToken: v.optional(v.string()),
  platform: v.union(v.literal('ios'), v.literal('android')),
})

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTHLY_PRO_KINDLING_GRANT = 3
const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000
const INACTIVE_CLAIM_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Computes the current kindling balance for a user from the immutable ledger.
 * Balance = SUM(positive amounts) − SUM(absolute value of negative amounts).
 * Always computed, never stored.
 */
export async function computeKindlingBalance(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<number> {
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  return transactions.reduce((balance, tx) => balance + tx.amount, 0)
}

function startOfUtcMonth(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function addUtcMonths(ts: number, months: number): number {
  const d = new Date(ts)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + months
  const day = d.getUTCDate()
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

  return Date.UTC(
    year,
    month,
    Math.min(day, lastDayOfTargetMonth),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  )
}

function getCalendarMonthPeriod(ts: number): { periodStart: number; periodEnd: number } {
  const periodStart = startOfUtcMonth(ts)
  return {
    periodStart,
    periodEnd: addUtcMonths(periodStart, 1),
  }
}

function getAnchoredMonthlyPeriod(
  anchorTs: number,
  ts: number,
): { periodStart: number; periodEnd: number } {
  const createdAt = new Date(anchorTs)
  const current = new Date(ts)
  let monthOffset =
    (current.getUTCFullYear() - createdAt.getUTCFullYear()) * 12 +
    (current.getUTCMonth() - createdAt.getUTCMonth())

  let periodStart = addUtcMonths(anchorTs, monthOffset)
  if (periodStart > ts) {
    monthOffset--
    periodStart = addUtcMonths(anchorTs, monthOffset)
  }

  return {
    periodStart,
    periodEnd: addUtcMonths(anchorTs, monthOffset + 1),
  }
}

function getSubscriptionGrantPeriod(
  subscription: Doc<'subscriptions'> | null,
  ts: number,
): { periodStart: number; periodEnd: number } {
  if (!subscription) {
    return getCalendarMonthPeriod(ts)
  }

  // Annual Pro plans still receive monthly kindling, anchored to the purchase date.
  if (subscription.storeProductId.endsWith('.annual')) {
    return getAnchoredMonthlyPeriod(subscription.createdAt, ts)
  }

  if (!subscription.currentPeriodEnd) {
    return getCalendarMonthPeriod(ts)
  }

  return {
    periodStart: addUtcMonths(subscription.currentPeriodEnd, -1),
    periodEnd: subscription.currentPeriodEnd,
  }
}

function periodsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd
}

async function getBestActiveProSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<Doc<'subscriptions'> | null> {
  const subscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  return (
    subscriptions
      .filter(
        (sub) =>
          sub.verificationStatus === 'verified' &&
          (sub.status === 'active' || sub.status === 'trialing') &&
          (!sub.currentPeriodEnd || sub.currentPeriodEnd > now) &&
          sub.tier === 'pro',
      )
      .sort((left, right) => (right.currentPeriodEnd ?? 0) - (left.currentPeriodEnd ?? 0))[0] ??
    null
  )
}

/**
 * Check if a monthly_consumption already covers this camp in the supplied
 * period. Overlap checks avoid double-charging camps whose first transaction
 * used an older calendar-month period before the anniversary model landed.
 */
async function consumptionExistsForPeriod(
  ctx: MutationCtx,
  userId: Id<'users'>,
  campId: Id<'camps'>,
  periodStart: number,
  periodEnd: number,
): Promise<boolean> {
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
    .filter((q) => q.eq(q.field('type'), 'monthly_consumption'))
    .collect()

  return transactions.some((tx) => {
    const txPeriodStart = tx.periodStart ?? tx.createdAt
    const txPeriodEnd = tx.periodEnd ?? addUtcMonths(txPeriodStart, 1)
    return periodsOverlap(txPeriodStart, txPeriodEnd, periodStart, periodEnd)
  })
}

/**
 * Check if a monthly_grant already covers this user in the supplied period.
 * Overlap checks preserve idempotency across the calendar-month to billing-
 * period transition.
 */
async function grantExistsForPeriod(
  ctx: MutationCtx,
  userId: Id<'users'>,
  periodStart: number,
  periodEnd: number,
): Promise<boolean> {
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .filter((q) => q.eq(q.field('type'), 'monthly_grant'))
    .collect()

  return transactions.some((tx) => {
    const txPeriodStart = tx.periodStart ?? tx.createdAt
    const txPeriodEnd = tx.periodEnd ?? addUtcMonths(txPeriodStart, 1)
    return periodsOverlap(txPeriodStart, txPeriodEnd, periodStart, periodEnd)
  })
}

async function getMonthlyKindlingGrantPeriod(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<{ periodStart: number; periodEnd: number }> {
  const subscription = await getBestActiveProSubscription(ctx, userId, now)
  return getSubscriptionGrantPeriod(subscription, now)
}

export async function burnKindlingForCamp(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; campId: Id<'camps'> },
): Promise<{ newBalance: number; alreadyConsumed: boolean; insufficientKindling?: true }> {
  const now = Date.now()
  const camp = await ctx.db.get(args.campId)
  if (!camp) {
    throw new Error('Camp not found')
  }
  const { periodStart, periodEnd } = getAnchoredMonthlyPeriod(camp.createdAt, now)

  // Idempotency: if this camp already has coverage for this period, skip.
  if (await consumptionExistsForPeriod(ctx, args.userId, args.campId, periodStart, periodEnd)) {
    const balance = await computeKindlingBalance(ctx, args.userId)
    return { newBalance: balance, alreadyConsumed: true }
  }

  const balance = await computeKindlingBalance(ctx, args.userId)

  if (balance < 1) {
    return { newBalance: balance, alreadyConsumed: false, insufficientKindling: true as const }
  }

  await ctx.db.insert('campSlotTransactions', {
    userId: args.userId,
    type: 'monthly_consumption',
    amount: -1,
    campId: args.campId,
    periodStart,
    periodEnd,
    createdAt: now,
  })

  return { newBalance: balance - 1, alreadyConsumed: false }
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns the user's computed kindling balance and recent transaction history.
 */
export const getKindlingBalance = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const transactions = await ctx.db
      .query('campSlotTransactions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .collect()

    const balance = transactions.reduce((sum, tx) => sum + tx.amount, 0)

    return { balance, transactions }
  },
})

export async function getKindlingUsageSummaryForUser(ctx: QueryCtx, userId: Id<'users'>) {
  // Verify the user is Pro-tier
  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  if (TIER_RANK[tier] < TIER_RANK.pro) {
    throwUserError('Kindling usage summary is only available for Pro subscribers')
  }

  const now = Date.now()

  // Current balance (using existing computeKindlingBalance)
  const balance = await computeKindlingBalance(ctx, userId)

  // Full transaction history
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .collect()

  const { periodStart, periodEnd } = await getMonthlyKindlingGrantPeriod(ctx, userId, now)
  const kindlingGrantedThisPeriod = transactions
    .filter(
      (tx) =>
        (tx.type === 'monthly_grant' || tx.type === 'slot_credit') &&
        tx.createdAt >= periodStart &&
        tx.createdAt < periodEnd,
    )
    .reduce((sum, tx) => sum + tx.amount, 0)

  const kindlingBurnedThisPeriod = transactions
    .filter(
      (tx) =>
        tx.type === 'monthly_consumption' &&
        tx.createdAt >= periodStart &&
        tx.createdAt < periodEnd,
    )
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0)

  const ownedCamps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect()

  const activeCamps = ownedCamps
    .filter(
      (camp) =>
        camp.status === 'active' ||
        (camp.status === 'grace' && (!camp.gracePeriodEnd || camp.gracePeriodEnd >= now)),
    )
    .map((camp) => {
      const { periodEnd: renewalDate } = getAnchoredMonthlyPeriod(camp.createdAt, now)

      return {
        campId: camp._id,
        slug: camp.slug,
        name: camp.name,
        access: camp.access,
        status: camp.status,
        renewalDate,
        kindlingCost: camp.status === 'active' ? 1 : 0,
        createdAt: camp.createdAt,
      }
    })
    .sort((left, right) => left.renewalDate - right.renewalDate)

  return {
    balance,
    periodStart,
    periodEnd,
    kindlingGrantedThisPeriod,
    kindlingBurnedThisPeriod,
    activeCamps,
    transactions,
  }
}

/**
 * Returns a comprehensive kindling usage summary for the authenticated Pro user.
 * Includes current balance, billing-period kindling movement, owned camp list with
 * renewal dates and kindling costs, and full transaction history.
 */
export const getKindlingUsageSummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    return getKindlingUsageSummaryForUser(ctx, userId)
  },
})

// ── Internal Query (server-only, no auth needed) ────────────────────────────

export const internalGetKindlingBalance = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const transactions = await ctx.db
      .query('campSlotTransactions')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect()

    const balance = transactions.reduce((sum, tx) => sum + tx.amount, 0)
    return { balance, transactions }
  },
})

// ── Internal Mutations ──────────────────────────────────────────────────────

/**
 * Burns 1 kindling for a specific camp for the current monthly period.
 *
 * - Computes current balance from ledger
 * - Balance can NEVER go negative — reports insufficient kindling without inserting
 * - Inserts a monthly_consumption ledger entry with campId, periodStart, periodEnd
 * - Returns the new balance after consumption
 */
export const burnCampKindling = internalMutation({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ newBalance: number; alreadyConsumed: boolean; insufficientKindling?: true }> => {
    return await burnKindlingForCamp(ctx, args)
  },
})

/**
 * Internal mutation: credits kindling balance from a consumable purchase.
 * Inserts N slot_credit entries (one per kindling) with the current period.
 * The transaction type name is retained for existing production data.
 * Kindling credits never expire (periodEnd = Infinity) — they are permanent
 * balance additions, not monthly grants.
 */
export const creditKindlingPurchase = internalMutation({
  args: {
    userId: v.id('users'),
    kindlingCount: v.number(),
    metadata: v.optional(kindlingCreditMetadataValidator),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.kindlingCount) || args.kindlingCount <= 0) {
      throw new Error('kindlingCount must be a positive integer')
    }

    const now = Date.now()
    const periodStart = startOfUtcMonth(now)
    for (let i = 0; i < args.kindlingCount; i++) {
      await ctx.db.insert('campSlotTransactions', {
        userId: args.userId,
        campId: undefined,
        type: 'slot_credit',
        amount: 1,
        periodStart,
        periodEnd: Number.POSITIVE_INFINITY,
        ...(args.metadata ? { metadata: args.metadata } : {}),
        createdAt: now,
      })
    }
    return { credited: args.kindlingCount }
  },
})

/**
 * Grants 3 free monthly kindling to a Pro user on their billing date.
 *
 * - Only runs for users with an active Pro subscription
 * - Period-bounded idempotent: checks for existing grant in the same month before inserting
 * - Inserts a monthly_grant ledger entry with amount +3
 * - Returns the new balance after grant
 */
export const grantMonthlyKindling = internalMutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<{ newBalance: number; alreadyGranted: boolean }> => {
    const tier = await getEntitlementSubscriptionTier(ctx, args.userId)

    if (TIER_RANK[tier] < TIER_RANK.pro) {
      throw new Error('Monthly kindling grants are only available for Pro subscribers')
    }

    const now = Date.now()
    const { periodStart, periodEnd } = await getMonthlyKindlingGrantPeriod(ctx, args.userId, now)

    // Idempotency: if grant already covers this billing period, skip.
    if (await grantExistsForPeriod(ctx, args.userId, periodStart, periodEnd)) {
      const balance = await computeKindlingBalance(ctx, args.userId)
      return { newBalance: balance, alreadyGranted: true }
    }

    const balance = await computeKindlingBalance(ctx, args.userId)

    await ctx.db.insert('campSlotTransactions', {
      userId: args.userId,
      type: 'monthly_grant',
      amount: MONTHLY_PRO_KINDLING_GRANT,
      periodStart,
      periodEnd,
      createdAt: now,
    })

    return { newBalance: balance + MONTHLY_PRO_KINDLING_GRANT, alreadyGranted: false }
  },
})

// ── Cron Job Handlers ───────────────────────────────────────────────────────

/**
 * Daily cron: burns 1 kindling for each active public camp that lacks coverage
 * for its current creation-anniversary period.
 *
 * Idempotent — safe to run multiple times a day. Per owner, oldest due camps
 * consume first so newer camps enter grace when kindling is insufficient.
 */
export const burnDailyCampKindling = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    const activePublicCamps = await ctx.db
      .query('camps')
      .filter((q) => q.and(q.neq(q.field('access'), 'invite'), q.eq(q.field('status'), 'active')))
      .collect()

    const dueCampsByOwner = new Map<Id<'users'>, Doc<'camps'>[]>()
    let burned = 0
    let graceEntered = 0
    let skipped = 0

    for (const camp of activePublicCamps) {
      if (!camp.ownerId) {
        skipped++
        continue
      }

      const { periodStart, periodEnd } = getAnchoredMonthlyPeriod(camp.createdAt, now)
      const alreadyConsumed = await consumptionExistsForPeriod(
        ctx,
        camp.ownerId,
        camp._id,
        periodStart,
        periodEnd,
      )
      if (alreadyConsumed) {
        skipped++
        continue
      }

      const ownerDueCamps = dueCampsByOwner.get(camp.ownerId) ?? []
      ownerDueCamps.push(camp)
      dueCampsByOwner.set(camp.ownerId, ownerDueCamps)
    }

    for (const [ownerId, dueCamps] of dueCampsByOwner) {
      dueCamps.sort((left, right) => left.createdAt - right.createdAt)

      for (const camp of dueCamps) {
        const result = await burnKindlingForCamp(ctx, {
          userId: ownerId,
          campId: camp._id,
        })

        if (result.alreadyConsumed) {
          skipped++
          continue
        }

        if (result.insufficientKindling) {
          const gracePeriodEnd = now + GRACE_PERIOD_MS
          await ctx.db.insert('campSlotTransactions', {
            userId: ownerId,
            type: 'grace_period_entry',
            amount: 0,
            campId: camp._id,
            metadata: {
              reason: 'insufficient_kindling',
            },
            createdAt: now,
          })
          await ctx.db.patch(camp._id, {
            status: 'grace',
            gracePeriodStart: now,
            gracePeriodEnd,
            updatedAt: now,
          })
          graceEntered++
        } else {
          burned++
        }
      }
    }

    // biome-ignore lint/suspicious/noConsole: cron job diagnostic logging
    console.log(
      `Daily camp kindling burn: ${burned} burned, ${graceEntered} entered grace, ${skipped} skipped`,
    )

    return { burned, graceEntered, skipped }
  },
})

/**
 * Daily cron: grants free monthly kindling to Pro users once per active billing
 * period.
 *
 * A user is eligible if they have an active Pro subscription and have not
 * received a monthly_grant covering the current billing period.
 * Idempotent — safe to run multiple times a day.
 *
 * Handles both store-subscription Pro users AND admin-forced Pro tier
 * users (via getEntitlementSubscriptionTier).
 */
export const grantDailyProKindling = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    // Find all users with active Pro subscriptions (store-based)
    const allSubscriptions = await ctx.db.query('subscriptions').collect()

    const proUserIds = new Set<Id<'users'>>()
    for (const sub of allSubscriptions) {
      if (
        sub.verificationStatus === 'verified' &&
        (sub.status === 'active' || sub.status === 'trialing') &&
        (!sub.currentPeriodEnd || sub.currentPeriodEnd > now) &&
        sub.tier === 'pro'
      ) {
        proUserIds.add(sub.userId)
      }
    }

    // Also include users with admin-forced Pro tier
    const forcedProUsers = await ctx.db
      .query('users')
      .filter((q) => q.eq(q.field('forcedTier'), 'pro'))
      .collect()
    for (const user of forcedProUsers) {
      proUserIds.add(user._id)
    }

    let granted = 0
    let alreadyGranted = 0
    let ineligible = 0

    for (const userId of proUserIds) {
      // Verify the user is actually Pro-tier (handles forcedTier too)
      const tier = await getEntitlementSubscriptionTier(ctx, userId)
      if (TIER_RANK[tier] < TIER_RANK.pro) {
        ineligible++
        continue
      }

      const { periodStart, periodEnd } = await getMonthlyKindlingGrantPeriod(ctx, userId, now)

      // Idempotency: check if grant already issued for this billing period.
      if (await grantExistsForPeriod(ctx, userId, periodStart, periodEnd)) {
        alreadyGranted++
        continue
      }

      await ctx.db.insert('campSlotTransactions', {
        userId,
        type: 'monthly_grant',
        amount: MONTHLY_PRO_KINDLING_GRANT,
        periodStart,
        periodEnd,
        createdAt: now,
      })
      granted++
    }

    // biome-ignore lint/suspicious/noConsole: cron job diagnostic logging
    console.log(
      `Daily Pro kindling grant: ${granted} granted, ${alreadyGranted} already granted, ${ineligible} ineligible`,
    )

    return { granted, alreadyGranted, ineligible }
  },
})

/**
 * Daily cron: transitions camps out of grace once their grace period has ended
 * and archives inactive camps whose claim window has expired.
 *
 * Idempotent — only patches camps currently in grace. Camps missing
 * gracePeriodEnd are treated as expired because grace without an end date
 * should not remain open indefinitely.
 */
export const expireGracePeriodCamps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const graceCamps = await ctx.db
      .query('camps')
      .filter((q) => q.eq(q.field('status'), 'grace'))
      .collect()

    let expired = 0
    let missingGracePeriodEnd = 0
    let archived = 0
    let skipped = 0

    for (const camp of graceCamps) {
      if (camp.gracePeriodEnd !== undefined && camp.gracePeriodEnd >= now) {
        skipped++
        continue
      }

      if (camp.gracePeriodEnd === undefined) {
        missingGracePeriodEnd++
        console.warn(`Grace camp ${camp._id} is missing gracePeriodEnd; marking inactive`)
      }

      await ctx.db.patch(camp._id, {
        status: 'inactive',
        gracePeriodStart: undefined,
        gracePeriodEnd: undefined,
        reclaimDeadline: now + INACTIVE_CLAIM_WINDOW_MS,
        updatedAt: now,
      })
      expired++
    }

    const inactiveCamps = await ctx.db
      .query('camps')
      .filter((q) =>
        q.and(
          q.neq(q.field('access'), 'invite'),
          q.eq(q.field('status'), 'inactive'),
          q.lte(q.field('reclaimDeadline'), now),
        ),
      )
      .collect()

    for (const camp of inactiveCamps) {
      await ctx.db.patch(camp._id, {
        status: 'archived',
        archivedAt: now,
        access: 'invite',
        reclaimDeadline: undefined,
        updatedAt: now,
      })
      archived++
    }

    // biome-ignore lint/suspicious/noConsole: cron job diagnostic logging
    console.log(
      `Grace expiration: ${expired} inactive, ${missingGracePeriodEnd} missing gracePeriodEnd, ${archived} archived, ${skipped} skipped`,
    )

    return { expired, missingGracePeriodEnd, archived, skipped }
  },
})
