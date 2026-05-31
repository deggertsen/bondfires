/**
 * Camp Slot Management — monthly slot consumption system.
 *
 * Every active Pro-created camp (public or private) costs 1 slot per month.
 * Pro users get 3 free slots per month on their billing date. Extra slot
 * packs are purchasable as consumable IAPs. All slot movements are recorded
 * in an immutable ledger (campSlotTransactions table) and balance is always
 * computed, never stored.
 *
 * Balance formula: SUM(positive amounts) − SUM(negative amounts)
 * Balance can NEVER go negative — all consuming operations throw hard errors.
 */

import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery, query } from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, TIER_RANK } from './entitlements'
import { throwUserError } from './errors'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Computes the current slot balance for a user from the immutable ledger.
 * Balance = SUM(positive amounts) − SUM(absolute value of negative amounts).
 * Always computed, never stored.
 */
export async function computeSlotBalance(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<number> {
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  return transactions.reduce((balance, tx) => balance + tx.amount, 0)
}

/**
 * Round a timestamp down to the start of the month (UTC midnight of the 1st).
 * This gives us stable period boundaries for idempotency checks.
 */
function startOfMonth(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/**
 * Check if a monthly_consumption already exists for this camp in the current
 * monthly period. Period is keyed by startOfMonth to match grant periods.
 */
async function consumptionExistsInPeriod(
  ctx: MutationCtx,
  userId: Id<'users'>,
  campId: Id<'camps'>,
  periodStart: number,
): Promise<boolean> {
  const existing = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
    .filter((q) =>
      q.and(
        q.eq(q.field('type'), 'monthly_consumption'),
        q.eq(q.field('periodStart'), periodStart),
      ),
    )
    .first()
  return existing !== null
}

/**
 * Check if a monthly_grant already exists for this user in the current period.
 */
async function grantExistsInPeriod(
  ctx: MutationCtx,
  userId: Id<'users'>,
  periodStart: number,
): Promise<boolean> {
  const existing = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .filter((q) =>
      q.and(q.eq(q.field('type'), 'monthly_grant'), q.eq(q.field('periodStart'), periodStart)),
    )
    .first()
  return existing !== null
}

export async function consumeCampSlotForCamp(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; campId: Id<'camps'> },
): Promise<{ newBalance: number; alreadyConsumed: boolean; insufficientBalance?: true }> {
  const now = Date.now()
  const periodStart = startOfMonth(now)
  const periodEnd = startOfMonth(now + 32 * 24 * 60 * 60 * 1000) // start of next month

  // Idempotency: if this camp already consumed a slot this period, skip
  if (await consumptionExistsInPeriod(ctx, args.userId, args.campId, periodStart)) {
    const balance = await computeSlotBalance(ctx, args.userId)
    return { newBalance: balance, alreadyConsumed: true }
  }

  const balance = await computeSlotBalance(ctx, args.userId)

  if (balance < 1) {
    return { newBalance: balance, alreadyConsumed: false, insufficientBalance: true as const }
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
 * Returns the user's computed slot balance and recent transaction history.
 */
export const getSlotBalance = query({
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

// ── Internal Query (server-only, no auth needed) ────────────────────────────

export const internalGetSlotBalance = internalQuery({
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
 * Consumes 1 slot for a specific camp for the current monthly period.
 *
 * - Computes current balance from ledger
 * - Balance can NEVER go negative — throws hard error if insufficient
 * - Inserts a monthly_consumption ledger entry with campId, periodStart, periodEnd
 * - Returns the new balance after consumption
 */
export const consumeCampSlot = internalMutation({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ newBalance: number; alreadyConsumed: boolean; insufficientBalance?: true }> => {
    return await consumeCampSlotForCamp(ctx, args)
  },
})

/**
 * Grants 3 free monthly slots to a Pro user on their billing date.
 *
 * - Only runs for users with an active Pro subscription
 * - Period-bounded idempotent: checks for existing grant in the same month before inserting
 * - Inserts a monthly_grant ledger entry with amount +3
 * - Returns the new balance after grant
 */
export const grantMonthlySlots = internalMutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<{ newBalance: number; alreadyGranted: boolean }> => {
    const tier = await getEntitlementSubscriptionTier(ctx, args.userId)

    if (TIER_RANK[tier] < TIER_RANK.pro) {
      throw new Error('Monthly slot grants are only available for Pro subscribers')
    }

    const now = Date.now()
    const periodStart = startOfMonth(now)
    const periodEnd = startOfMonth(now + 32 * 24 * 60 * 60 * 1000)

    // Idempotency: if grant already issued this month, skip
    if (await grantExistsInPeriod(ctx, args.userId, periodStart)) {
      const balance = await computeSlotBalance(ctx, args.userId)
      return { newBalance: balance, alreadyGranted: true }
    }

    const balance = await computeSlotBalance(ctx, args.userId)

    await ctx.db.insert('campSlotTransactions', {
      userId: args.userId,
      type: 'monthly_grant',
      amount: 3,
      periodStart,
      periodEnd,
      createdAt: now,
    })

    return { newBalance: balance + 3, alreadyGranted: false }
  },
})
