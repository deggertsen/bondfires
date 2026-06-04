/**
 * Camp Slot Reconciliation & Refund Handling.
 *
 * - Daily reconciliation cron (runs at 14:00 UTC) performs 4 integrity checks.
 * - Internal refund mutation for admin-triggered purchase reversals.
 * - Query endpoints for admin dashboard surfacing.
 *
 * Refunds reverse the FULL purchase amount (even if partially consumed).
 * Negative balance after refund triggers immediate camp freeze
 * (newest camps frozen first, oldest preserved).
 */

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalAction, internalMutation, internalQuery, query } from './_generated/server'
import { computeSlotBalance } from './campSlots'

// ── Helpers ────────────────────────────────────────────────────────────────

const UNVERIFIED_THRESHOLD_MS = 24 * 60 * 60 * 1000

async function countConsumedSlotsFromPurchase(
  ctx: MutationCtx,
  purchase: { userId: Id<'users'>; createdAt: number },
): Promise<number> {
  const transactions = await ctx.db
    .query('campSlotTransactions')
    .withIndex('by_user', (q) => q.eq('userId', purchase.userId))
    .filter((q) =>
      q.and(
        q.eq(q.field('type'), 'monthly_consumption'),
        q.gte(q.field('createdAt'), purchase.createdAt),
      ),
    )
    .collect()

  return transactions.reduce((sum, tx) => sum + Math.abs(tx.amount), 0)
}

/**
 * Freeze active public camps owned by the user to cover a slot deficit.
 * Freezes newest camps first, oldest preserved. Private camps are not frozen.
 * Returns the number of camps frozen.
 */
async function freezeCampsToCoverDeficit(
  ctx: MutationCtx,
  userId: Id<'users'>,
  deficit: number,
  now: number,
): Promise<number> {
  const camps = await ctx.db
    .query('camps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .filter((q) => q.and(q.neq(q.field('access'), 'invite'), q.eq(q.field('status'), 'active')))
    .order('desc')
    .collect()

  let frozen = 0
  for (const camp of camps) {
    if (frozen >= deficit) break
    await ctx.db.patch(camp._id, {
      status: 'frozen',
      frozenAt: now,
      reclaimDeadline: now + 30 * 24 * 60 * 60 * 1000, // 30-day reclaim window
      updatedAt: now,
    })
    frozen++
  }
  return frozen
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * List recent reconciliation discrepancies for the admin dashboard.
 * Defaults to 50 most recent entries.
 */
export const listRecentDiscrepancies = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return ctx.db
      .query('reconciliationLog')
      .withIndex('by_created')
      .order('desc')
      .take(args.limit ?? 50)
  },
})

// ── Internal Mutations ──────────────────────────────────────────────────────

/**
 * Internal mutation: refund a verified consumable purchase.
 *
 * - Reverses the FULL purchase amount (even if partially consumed)
 * - Inserts a refund ledger entry
 * - If balance goes negative, freezes newest public camps to cover the deficit
 * - Marks the purchase as 'refunded'
 * - Logs to reconciliation
 */
export const refundPurchase = internalMutation({
  args: {
    purchaseId: v.id('consumablePurchases'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const purchase = await ctx.db.get(args.purchaseId)
    if (!purchase) throw new Error('Purchase not found')
    if (purchase.verificationStatus !== 'verified') {
      throw new Error('Cannot refund unverified purchase')
    }

    // Check for existing refund for this purchase
    const existingRefund = await ctx.db
      .query('campSlotTransactions')
      .withIndex('by_user', (q) => q.eq('userId', purchase.userId))
      .filter((q) =>
        q.and(q.eq(q.field('type'), 'refund'), q.eq(q.field('metadata.purchaseId'), purchase._id)),
      )
      .first()
    if (existingRefund) throw new Error('Purchase already refunded')

    // Count how many slots from this purchase were consumed
    const consumedCount = await countConsumedSlotsFromPurchase(ctx, purchase)

    // Insert refund ledger entry (reverse full purchase amount)
    const now = Date.now()
    await ctx.db.insert('campSlotTransactions', {
      userId: purchase.userId,
      type: 'refund',
      amount: -purchase.quantity,
      metadata: {
        purchaseId: purchase._id,
        storeTransactionId: purchase.storeTransactionId,
        consumedAtRefund: consumedCount,
        reason: args.reason,
        partialRefund: consumedCount > 0,
      },
      createdAt: now,
    })

    // If resulting balance < 0, freeze camps (newest first, oldest preserved)
    const balance = await computeSlotBalance(ctx, purchase.userId)
    let campsFrozen = 0
    if (balance < 0) {
      campsFrozen = await freezeCampsToCoverDeficit(ctx, purchase.userId, Math.abs(balance), now)
    }

    // Mark purchase as refunded
    await ctx.db.patch(args.purchaseId, {
      verificationStatus: 'refunded',
      updatedAt: now,
    })

    // Log to reconciliation
    await ctx.db.insert('reconciliationLog', {
      severity: 'info',
      category: 'refund',
      message: `Refunded ${purchase.quantity} slots (${consumedCount} consumed, balance now ${balance}, ${campsFrozen} camps frozen)`,
      userId: purchase.userId,
      purchaseId: purchase._id,
      transactionId: purchase.storeTransactionId,
      metadata: {
        reason: args.reason,
        consumedAtRefund: consumedCount,
        newBalance: balance,
        campsFrozen,
      },
      createdAt: now,
    })

    return {
      refunded: purchase.quantity,
      consumedAtRefund: consumedCount,
      newBalance: balance,
      campsFrozen,
    }
  },
})

// ── Internal Actions ────────────────────────────────────────────────────────

/**
 * Daily reconciliation: runs 4 integrity checks comparing ledger data
 * against verified store purchases and reports discrepancies.
 */
export const dailyReconciliation = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    orphaned: number
    unverified: number
    drifts: number
    duplicates: number
  }> => {
    const now = Date.now()

    // ── A. Orphaned ledger credits ────────────────────────────────────────
    // slot_credit entries with no matching consumablePurchases record.
    const orphaned: Array<{ userId: string; _id: string }> = await ctx.runQuery(
      internal.reconciliation.findOrphanedCredits,
      {},
    )

    for (const credit of orphaned) {
      await ctx.runMutation(internal.reconciliation.logDiscrepancy, {
        severity: 'warning' as const,
        category: 'orphaned_credit',
        message: `Orphaned slot_credit with no matching consumablePurchase (userId: ${credit.userId})`,
        userId: credit.userId as Id<'users'>,
        metadata: { slotTransactionId: credit._id },
        createdAt: now,
      })
    }

    // ── B. Unverified purchases > 24h old ─────────────────────────────────
    const unverified: Array<{
      _id: string
      userId: string
      storeProductId: string
      storeTransactionId?: string
      quantity: number
      createdAt: number
      platform: string
    }> = await ctx.runQuery(internal.reconciliation.findUnverifiedPurchases, {
      threshold: now - UNVERIFIED_THRESHOLD_MS,
    })

    for (const purchase of unverified) {
      await ctx.runMutation(internal.reconciliation.logDiscrepancy, {
        severity: 'warning' as const,
        category: 'unverified_purchase',
        message: `Unverified purchase older than 24h (${purchase.storeProductId}, quantity: ${purchase.quantity})`,
        userId: purchase.userId as Id<'users'>,
        purchaseId: purchase._id as Id<'consumablePurchases'>,
        transactionId: purchase.storeTransactionId,
        metadata: { createdAt: purchase.createdAt, platform: purchase.platform },
        createdAt: now,
      })
    }

    // ── C. Balance drift ─────────────────────────────────────────────────
    const drifts: Array<{
      userId: string
      expected: number
      actual: number
      drift: number
    }> = await ctx.runQuery(internal.reconciliation.findBalanceDrift, {})

    for (const drift of drifts) {
      await ctx.runMutation(internal.reconciliation.logDiscrepancy, {
        severity: 'error' as const,
        category: 'balance_drift',
        message: `Balance drift for user ${drift.userId}: expected ${drift.expected}, actual ${drift.actual}, drift ${drift.drift}`,
        userId: drift.userId as Id<'users'>,
        metadata: {
          expected: drift.expected,
          actual: drift.actual,
          drift: drift.drift,
        },
        createdAt: now,
      })
    }

    // ── D. Duplicate store transactions ──────────────────────────────────
    const duplicates: Array<{
      storeTransactionId: string
      count: number
      purchaseIds: string[]
    }> = await ctx.runQuery(internal.reconciliation.findDuplicateTransactions, {})

    for (const dup of duplicates) {
      await ctx.runMutation(internal.reconciliation.logDiscrepancy, {
        severity: 'error' as const,
        category: 'duplicate_transaction',
        message: `Duplicate store transaction: ${dup.storeTransactionId} (${dup.count} purchases)`,
        transactionId: dup.storeTransactionId,
        metadata: { count: dup.count, purchaseIds: dup.purchaseIds },
        createdAt: now,
      })
    }

    // ── Log summary ───────────────────────────────────────────────────────
    const total = orphaned.length + unverified.length + drifts.length + duplicates.length

    await ctx.runMutation(internal.reconciliation.logDiscrepancy, {
      severity: 'info' as const,
      category: 'reconciliation_summary',
      message: `Daily reconciliation complete: ${orphaned.length} orphaned, ${unverified.length} unverified, ${drifts.length} drifts, ${duplicates.length} duplicates (${total} total)`,
      createdAt: now,
    })

    return {
      orphaned: orphaned.length,
      unverified: unverified.length,
      drifts: drifts.length,
      duplicates: duplicates.length,
    }
  },
})

// ── Internal Queries & Mutations (used by the action) ──────────────────────

/**
 * Find slot_credit transactions that reference consumablePurchases
 * which no longer exist.
 */
export const findOrphanedCredits = internalQuery({
  args: {},
  handler: async (ctx) => {
    const creditTransactions = await ctx.db
      .query('campSlotTransactions')
      .filter((q) => q.eq(q.field('type'), 'slot_credit'))
      .collect()

    const orphaned = []
    for (const credit of creditTransactions) {
      const metadata = credit.metadata as
        | { consumablePurchaseId?: Id<'consumablePurchases'> }
        | undefined
      if (!metadata?.consumablePurchaseId) continue
      const purchase = await ctx.db.get(metadata.consumablePurchaseId)
      if (!purchase) {
        orphaned.push(credit)
      }
    }
    return orphaned
  },
})

/**
 * Find consumablePurchases that are still unverified after the threshold.
 */
export const findUnverifiedPurchases = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query('consumablePurchases')
      .filter((q) =>
        q.and(
          q.eq(q.field('verificationStatus'), 'pending'),
          q.lt(q.field('createdAt'), args.threshold),
        ),
      )
      .collect()
  },
})

/**
 * Find users whose computed ledger balance differs from the expected balance
 * derived from verified purchases, grants, consumptions, and refunds.
 */
export const findBalanceDrift = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get all users who have any camp slot transactions
    const allUsers = await ctx.db.query('users').collect()
    const drifts: Array<{ userId: string; expected: number; actual: number; drift: number }> = []

    // We only check users with transactions to avoid noise
    for (const user of allUsers) {
      const transactions = await ctx.db
        .query('campSlotTransactions')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect()

      if (transactions.length === 0) continue

      const actual = transactions.reduce((sum, tx) => sum + tx.amount, 0)

      // Compute expected: verified purchases credit + grants + refunds - consumptions
      const purchases = await ctx.db
        .query('consumablePurchases')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .filter((q) => q.eq(q.field('verificationStatus'), 'verified'))
        .collect()

      const expectedFromPurchases = purchases.reduce((sum, p) => sum + p.quantity, 0)
      const expectedFromRefunds = transactions
        .filter((t) => t.type === 'refund')
        .reduce((sum, t) => sum + t.amount, 0)

      const expected =
        expectedFromPurchases +
        transactions
          .filter((t) => t.type === 'monthly_grant')
          .reduce((sum, t) => sum + t.amount, 0) +
        expectedFromRefunds +
        transactions
          .filter((t) => t.type === 'monthly_consumption')
          .reduce((sum, t) => sum + t.amount, 0)

      if (actual !== expected) {
        drifts.push({
          userId: user._id,
          expected,
          actual,
          drift: actual - expected,
        })
      }
    }
    return drifts
  },
})

/**
 * Find consumablePurchases with duplicate store transaction IDs.
 */
export const findDuplicateTransactions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const purchases = await ctx.db.query('consumablePurchases').collect()

    const counts = new Map<string, Id<'consumablePurchases'>[]>()
    for (const purchase of purchases) {
      if (!purchase.storeTransactionId) continue
      const existing = counts.get(purchase.storeTransactionId) ?? []
      existing.push(purchase._id)
      counts.set(purchase.storeTransactionId, existing)
    }

    const duplicates = []
    for (const [storeTransactionId, purchaseIds] of counts) {
      if (purchaseIds.length > 1) {
        duplicates.push({
          storeTransactionId,
          count: purchaseIds.length,
          purchaseIds,
        })
      }
    }
    return duplicates
  },
})

/**
 * Log a single discrepancy entry. Used by the daily reconciliation action
 * to record findings atomically.
 */
export const logDiscrepancy = internalMutation({
  args: {
    severity: v.union(v.literal('info'), v.literal('warning'), v.literal('error')),
    category: v.string(),
    message: v.string(),
    userId: v.optional(v.id('users')),
    purchaseId: v.optional(v.id('consumablePurchases')),
    transactionId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('reconciliationLog', {
      severity: args.severity,
      category: args.category,
      message: args.message,
      userId: args.userId,
      purchaseId: args.purchaseId,
      transactionId: args.transactionId,
      metadata: args.metadata,
      createdAt: args.createdAt,
    })
  },
})
