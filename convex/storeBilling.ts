import { v } from 'convex/values'
import { internalMutation, internalQuery, query } from './_generated/server'
import { auth } from './auth'
import {
  boundedReconciliationLimit,
  canClaimStoreEvent,
  nextStoreSyncAt,
} from './lib/storeBillingPolicy'

const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000

const platformValidator = v.union(v.literal('ios'), v.literal('android'))

export const setStoreAccountTokenIfMissing = internalMutation({
  args: { userId: v.id('users'), candidate: v.string() },
  handler: async (ctx, args) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.candidate)
    ) {
      throw new Error('Invalid store account token')
    }
    const user = await ctx.db.get(args.userId)
    if (!user) throw new Error('User not found')
    if (user.storeAccountToken) return user.storeAccountToken
    await ctx.db.patch(args.userId, { storeAccountToken: args.candidate })
    return args.candidate
  },
})

export const getVerificationContext = internalQuery({
  args: {
    userId: v.id('users'),
    kind: v.union(v.literal('subscription'), v.literal('consumable')),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (!user?.storeAccountToken) throw new Error('Store account binding is not initialized')

    const existing =
      args.kind === 'subscription'
        ? args.storeOriginalTransactionId
          ? (
              await ctx.db
                .query('subscriptions')
                .withIndex('by_store_transaction', (q) =>
                  q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
                )
                .collect()
            ).find(
              (record) => record.userId === args.userId && record.verificationStatus === 'verified',
            )
          : args.storePurchaseToken
            ? (
                await ctx.db
                  .query('subscriptions')
                  .withIndex('by_store_purchase_token', (q) =>
                    q.eq('storePurchaseToken', args.storePurchaseToken),
                  )
                  .collect()
              ).find(
                (record) =>
                  record.userId === args.userId && record.verificationStatus === 'verified',
              )
            : null
        : args.storeOriginalTransactionId
          ? (
              await ctx.db
                .query('consumablePurchases')
                .withIndex('by_store_transaction', (q) =>
                  q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
                )
                .collect()
            ).find(
              (record) => record.userId === args.userId && record.verificationStatus === 'verified',
            )
          : args.storePurchaseToken
            ? (
                await ctx.db
                  .query('consumablePurchases')
                  .withIndex('by_store_purchase_token', (q) =>
                    q.eq('storePurchaseToken', args.storePurchaseToken),
                  )
                  .collect()
              ).find(
                (record) =>
                  record.userId === args.userId && record.verificationStatus === 'verified',
              )
            : null

    return {
      expectedAccountToken: user.storeAccountToken,
      alreadyVerifiedForUser:
        existing?.userId === args.userId && existing.verificationStatus === 'verified',
    }
  },
})

export const findSubscriptionForStoreSubject = internalQuery({
  args: {
    platform: platformValidator,
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const subscriptions = args.storeOriginalTransactionId
      ? await ctx.db
          .query('subscriptions')
          .withIndex('by_store_transaction', (q) =>
            q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
          )
          .collect()
      : args.storePurchaseToken
        ? await ctx.db
            .query('subscriptions')
            .withIndex('by_store_purchase_token', (q) =>
              q.eq('storePurchaseToken', args.storePurchaseToken),
            )
            .collect()
        : []
    return (
      subscriptions.find(
        (subscription) =>
          subscription.platform === args.platform && subscription.verificationStatus === 'verified',
      ) ?? null
    )
  },
})

export const claimEvent = internalMutation({
  args: {
    eventKey: v.string(),
    platform: platformValidator,
    version: v.string(),
    notificationType: v.string(),
    subtype: v.optional(v.string()),
    subjectHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('storeBillingEvents')
      .withIndex('by_event_key', (q) => q.eq('eventKey', args.eventKey))
      .first()
    if (!canClaimStoreEvent(existing, now)) {
      return {
        claimed: false,
        complete: existing?.status === 'processed' || existing?.status === 'ignored',
        attempts: existing?.attempts ?? 0,
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'processing',
        attempts: existing.attempts + 1,
        lastAttemptAt: now,
        lastErrorCode: undefined,
      })
    } else {
      await ctx.db.insert('storeBillingEvents', {
        ...args,
        status: 'processing',
        attempts: 1,
        receivedAt: now,
        lastAttemptAt: now,
      })
    }
    return { claimed: true, complete: false, attempts: (existing?.attempts ?? 0) + 1 }
  },
})

export const completeEvent = internalMutation({
  args: { eventKey: v.string(), ignored: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query('storeBillingEvents')
      .withIndex('by_event_key', (q) => q.eq('eventKey', args.eventKey))
      .first()
    if (!event) throw new Error('Billing event claim not found')
    await ctx.db.patch(event._id, {
      status: args.ignored ? 'ignored' : 'processed',
      processedAt: Date.now(),
      lastErrorCode: undefined,
    })
  },
})

export const failEvent = internalMutation({
  args: { eventKey: v.string(), errorCode: v.string() },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query('storeBillingEvents')
      .withIndex('by_event_key', (q) => q.eq('eventKey', args.eventKey))
      .first()
    if (!event || event.status === 'processed' || event.status === 'ignored') return
    await ctx.db.patch(event._id, { status: 'failed', lastErrorCode: args.errorCode.slice(0, 80) })
  },
})

export const getReconciliationBatch = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = boundedReconciliationLimit(args.limit)
    const now = Date.now()
    const candidates = await ctx.db
      .query('subscriptions')
      .withIndex('by_verification_next_sync', (q) => q.eq('verificationStatus', 'verified'))
      .order('asc')
      .take(limit * 3)
    return candidates
      .filter(
        (subscription) =>
          (subscription.nextStoreSyncAt === undefined || subscription.nextStoreSyncAt <= now) &&
          (subscription.storeOriginalTransactionId || subscription.storePurchaseToken),
      )
      .slice(0, limit)
  },
})

export const recordReconciliationFailure = internalMutation({
  args: { subscriptionId: v.id('subscriptions'), errorCode: v.string() },
  handler: async (ctx, args) => {
    const subscription = await ctx.db.get(args.subscriptionId)
    if (!subscription) return
    const now = Date.now()
    const failureCount = (subscription.storeSyncFailureCount ?? 0) + 1
    await ctx.db.patch(args.subscriptionId, {
      storeSyncFailureCount: failureCount,
      lastStoreSyncErrorCode: args.errorCode.slice(0, 80),
      nextStoreSyncAt: nextStoreSyncAt(now, subscription.storeState ?? 'pending', failureCount),
      updatedAt: now,
    })
  },
})

export const purgeOldEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('storeBillingEvents')
      .withIndex('by_received', (q) => q.lt('receivedAt', Date.now() - EVENT_RETENTION_MS))
      .take(100)
    for (const row of rows) await ctx.db.delete(row._id)
    return { deleted: rows.length, remainingMayExist: rows.length === 100 }
  },
})

export const billingHealth = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Not authenticated')
    const user = await ctx.db.get(userId)
    if (!user?.isAdmin && user?.role !== 'admin') throw new Error('Admin access required')
    const now = Date.now()
    const [failedEvents, processingEvents, overdueSubscriptions] = await Promise.all([
      ctx.db
        .query('storeBillingEvents')
        .withIndex('by_status_received', (q) => q.eq('status', 'failed'))
        .order('desc')
        .take(50),
      ctx.db
        .query('storeBillingEvents')
        .withIndex('by_status_received', (q) => q.eq('status', 'processing'))
        .order('desc')
        .take(50),
      ctx.db
        .query('subscriptions')
        .withIndex('by_verification_next_sync', (q) => q.eq('verificationStatus', 'verified'))
        .order('asc')
        .take(50),
    ])
    return {
      failedEvents: failedEvents.map(
        ({ platform, notificationType, attempts, receivedAt, lastErrorCode }) => ({
          platform,
          notificationType,
          attempts,
          receivedAt,
          lastErrorCode,
        }),
      ),
      processingOlderThanFiveMinutes: processingEvents.filter(
        (event) => event.lastAttemptAt < now - 5 * 60 * 1_000,
      ).length,
      overdueReconciliations: overdueSubscriptions.filter(
        (subscription) =>
          subscription.nextStoreSyncAt === undefined || subscription.nextStoreSyncAt <= now,
      ).length,
      overdueReconciliationsMayExceedLimit:
        overdueSubscriptions.length === 50 &&
        overdueSubscriptions.every(
          (subscription) =>
            subscription.nextStoreSyncAt === undefined || subscription.nextStoreSyncAt <= now,
        ),
    }
  },
})
