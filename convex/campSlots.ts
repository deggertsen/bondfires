/**
 * Backward-compatible camp slot API.
 *
 * The product language is now "kindling", but deployed clients and internal
 * callers may still reference the old campSlots Convex module.
 */

import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation, query } from './_generated/server'
import { auth } from './auth'
import {
  burnDailyCampKindling,
  burnKindlingForCamp,
  computeKindlingBalance,
  expireGracePeriodCamps,
  getKindlingBalance,
  getKindlingUsageSummaryForUser,
  grantDailyProKindling,
  grantMonthlyKindling,
  internalGetKindlingBalance,
} from './campKindling'
import { throwUserError } from './errors'

const slotCreditMetadataValidator = v.object({
  consumablePurchaseId: v.id('consumablePurchases'),
  storeProductId: v.string(),
  storeTransactionId: v.optional(v.string()),
  storeOriginalTransactionId: v.optional(v.string()),
  storePurchaseToken: v.optional(v.string()),
  platform: v.union(v.literal('ios'), v.literal('android')),
})

function startOfUtcMonth(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export const computeSlotBalance = computeKindlingBalance

export async function consumeCampSlotForCamp(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; campId: Id<'camps'> },
): Promise<{ newBalance: number; alreadyConsumed: boolean; insufficientBalance?: true }> {
  const result = await burnKindlingForCamp(ctx, args)
  if (result.insufficientKindling) {
    return {
      newBalance: result.newBalance,
      alreadyConsumed: result.alreadyConsumed,
      insufficientBalance: true,
    }
  }

  return {
    newBalance: result.newBalance,
    alreadyConsumed: result.alreadyConsumed,
  }
}

export const getSlotBalance = getKindlingBalance

export const getSlotUsageSummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const summary = await getKindlingUsageSummaryForUser(ctx, userId)
    return {
      ...summary,
      slotsGrantedThisPeriod: summary.kindlingGrantedThisPeriod,
      slotsConsumedThisPeriod: summary.kindlingBurnedThisPeriod,
      activeCamps: summary.activeCamps.map((activeCamp) => ({
        ...activeCamp,
        slotCost: activeCamp.kindlingCost,
      })),
    }
  },
})

export const internalGetSlotBalance = internalGetKindlingBalance

export const consumeCampSlot = internalMutation({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => consumeCampSlotForCamp(ctx, args),
})

export const creditSlotPurchase = internalMutation({
  args: {
    userId: v.id('users'),
    slotCount: v.number(),
    metadata: v.optional(slotCreditMetadataValidator),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.slotCount) || args.slotCount <= 0) {
      throw new Error('slotCount must be a positive integer')
    }

    const now = Date.now()
    const periodStart = startOfUtcMonth(now)
    for (let i = 0; i < args.slotCount; i++) {
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
    return { credited: args.slotCount }
  },
})

export const grantMonthlySlots = grantMonthlyKindling
export const burnDailyCampSlots = burnDailyCampKindling
export const grantDailyProSlots = grantDailyProKindling
export { expireGracePeriodCamps }
