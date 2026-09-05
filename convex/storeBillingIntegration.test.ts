import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import { readBoundedBody } from './http'
import { assertStoreAccountOwnership } from './lib/storeBillingPolicy'
import {
  claimEvent,
  completeEvent,
  failEvent,
  getVerificationContext,
  setStoreAccountTokenIfMissing,
} from './storeBilling'
import { applyStorePurchaseVerification, verifyStorePurchase } from './subscriptions'

vi.mock('./auth', () => ({ auth: { getUserId: async () => 'buyer', addHttpRoutes: () => {} } }))
vi.mock('./entitlements', () => ({
  getActiveSubscriptionTier: async () => 'free',
  getEntitlementSubscriptionTier: async () => 'free',
  TIER_RANK: { free: 0, plus: 1, premium: 2, pro: 3 },
}))

type Row = Record<string, unknown> & { _id: string }
function handler<C>(fn: unknown) {
  return (fn as { _handler: (ctx: C, args: Record<string, unknown>) => Promise<unknown> })._handler
}

describe('billing integration safeguards', () => {
  afterEach(() => vi.restoreAllMocks())
  let tables: Record<string, Row[]>
  let ctx: MutationCtx
  const purchase = {
    userId: 'buyer',
    kind: 'subscription',
    platform: 'android',
    requestedStoreProductId: 'bondfires.plus.monthly',
    storeProductId: 'bondfires.plus.monthly',
    storeOriginalTransactionId: 'real-token',
    storePurchaseToken: 'real-token',
    status: 'active',
    storeReadStartedAt: 200,
  }
  beforeEach(() => {
    tables = {
      users: [{ _id: 'buyer' }],
      subscriptions: [],
      deletedAccountPurchaseRecords: [],
      consumablePurchases: [],
      storeBillingEvents: [],
    }
    ctx = {
      db: {
        get: async (id: string) =>
          Object.values(tables)
            .flat()
            .find((row) => row._id === id) ?? null,
        query: (table: string) => {
          let rows = [...(tables[table] ?? [])]
          const range = {
            eq: (key: string, value: unknown) => {
              rows = rows.filter((row) => row[key] === value)
              return range
            },
          }
          const query = {
            withIndex: (_name: string, filter: (q: typeof range) => unknown) => {
              filter(range)
              return query
            },
            collect: async () => rows,
            first: async () => rows[0] ?? null,
          }
          return query
        },
        patch: vi.fn(async (id: string, fields: Record<string, unknown>) => {
          Object.assign(
            Object.values(tables)
              .flat()
              .find((row) => row._id === id) ?? {},
            fields,
          )
        }),
        insert: vi.fn(async (table: string, fields: Record<string, unknown>) => {
          const row = { ...fields, _id: `new-${tables[table].length}` }
          tables[table].push(row)
          return row._id
        }),
      },
      runMutation: vi.fn(),
    } as unknown as MutationCtx
  })

  it('fences a stale event worker after its lease has been reclaimed', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const event = {
      eventKey: 'apple:test',
      platform: 'ios',
      version: '2.0',
      notificationType: 'TEST',
    }
    await handler<MutationCtx>(claimEvent)(ctx, event)
    clock.mockReturnValue(302_000)
    await handler<MutationCtx>(claimEvent)(ctx, event)
    await handler<MutationCtx>(completeEvent)(ctx, { eventKey: event.eventKey, attempt: 1 })
    await handler<MutationCtx>(failEvent)(ctx, {
      eventKey: event.eventKey,
      attempt: 1,
      errorCode: 'stale',
    })
    expect(tables.storeBillingEvents[0]).toMatchObject({ status: 'processing', attempts: 2 })
    await handler<MutationCtx>(completeEvent)(ctx, { eventKey: event.eventKey, attempt: 2 })
    expect(tables.storeBillingEvents[0].status).toBe('processed')
  })

  it('bounds streamed webhook bodies without trusting content-length', async () => {
    const canceled = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20))
        controller.enqueue(new Uint8Array(20))
      },
      cancel: canceled,
    })
    const request = { headers: new Headers(), body } as Request
    expect(await readBoundedBody(request, 25)).toBeNull()
    expect(canceled).toHaveBeenCalledOnce()
  })

  it.each(['subscription', 'consumable'])(
    'checks provider tombstones at final %s application',
    async (kind) => {
      tables.deletedAccountPurchaseRecords.push({
        _id: 'tombstone',
        storePurchaseToken: 'real-token',
      })
      await expect(
        handler<MutationCtx>(applyStorePurchaseVerification)(ctx, {
          ...purchase,
          kind,
          storeProductId:
            kind === 'consumable' ? 'bondfires.camp_slots.3pack' : purchase.storeProductId,
          lookupStorePurchaseToken: 'different-client-lookup',
        }),
      ).rejects.toThrow(/deleted account/)
      expect(ctx.db.insert).not.toHaveBeenCalled()
    },
  )

  it.each([true, false])(
    'does not write after deletion starts or completes (exists=%s)',
    async (exists) => {
      tables.users = exists ? [{ _id: 'buyer', accountDeletionStatus: 'pending' }] : []
      expect(await handler<MutationCtx>(applyStorePurchaseVerification)(ctx, purchase)).toEqual({
        tier: 'free',
        status: 'expired',
      })
      expect(ctx.db.insert).not.toHaveBeenCalled()
    },
  )

  it('does not let a pending client lookup hide another account owning the provider purchase', async () => {
    tables.subscriptions.push(
      {
        _id: 'pending',
        userId: 'buyer',
        storeProductId: purchase.storeProductId,
        verificationStatus: 'pending',
        status: 'pending_verification',
      },
      {
        _id: 'owned',
        userId: 'other',
        storeProductId: purchase.storeProductId,
        verificationStatus: 'verified',
        storePurchaseToken: 'real-token',
      },
    )
    await expect(
      handler<MutationCtx>(applyStorePurchaseVerification)(ctx, purchase),
    ).rejects.toThrow(/another account/)
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('allows a tokenless legacy verified record only for its existing owner', async () => {
    tables.subscriptions.push({
      _id: 'legacy',
      userId: 'buyer',
      verificationStatus: 'verified',
      storePurchaseToken: 'real-token',
    })
    const ownership = (await handler<QueryCtx>(getVerificationContext)(ctx, {
      userId: 'buyer',
      kind: 'subscription',
      storePurchaseToken: 'real-token',
    })) as Parameters<typeof assertStoreAccountOwnership>[0]
    expect(ownership).toEqual({ expectedAccountToken: undefined, alreadyVerifiedForUser: true })
    expect(() => assertStoreAccountOwnership(ownership)).not.toThrow()
    const unowned = (await handler<QueryCtx>(getVerificationContext)(ctx, {
      userId: 'buyer',
      kind: 'subscription',
      storePurchaseToken: 'unknown',
    })) as Parameters<typeof assertStoreAccountOwnership>[0]
    expect(() => assertStoreAccountOwnership(unowned)).toThrow(/binding/)
  })

  it('does not initialize a store token during account deletion', async () => {
    tables.users[0].accountDeletionStatus = 'pending'
    await expect(
      handler<MutationCtx>(setStoreAccountTokenIfMissing)(ctx, {
        userId: 'buyer',
        candidate: '12345678-1234-4234-8234-123456789abc',
      }),
    ).rejects.toThrow(/unavailable/)
  })

  it('ignores an older store read arriving after a newer revocation', async () => {
    tables.subscriptions.push({
      _id: 'owned',
      userId: 'buyer',
      storeProductId: purchase.storeProductId,
      verificationStatus: 'refunded',
      status: 'expired',
      storePurchaseToken: 'real-token',
      lastStoreReadStartedAt: 300,
    })
    expect(await handler<MutationCtx>(applyStorePurchaseVerification)(ctx, purchase)).toEqual({
      tier: 'free',
      status: 'expired',
    })
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('retires a Play replacement token and prevents later restore from reactivating it', async () => {
    tables.subscriptions.push({
      _id: 'old',
      userId: 'buyer',
      storeProductId: purchase.storeProductId,
      verificationStatus: 'verified',
      status: 'active',
      storePurchaseToken: 'old-token',
    })
    await handler<MutationCtx>(applyStorePurchaseVerification)(ctx, {
      ...purchase,
      linkedPurchaseToken: 'old-token',
    })
    expect(tables.subscriptions[0]).toMatchObject({
      status: 'expired',
      replacedByStorePurchaseToken: 'real-token',
    })
    const result = await handler<MutationCtx>(applyStorePurchaseVerification)(ctx, {
      ...purchase,
      storePurchaseToken: 'old-token',
      storeOriginalTransactionId: 'old-token',
      storeReadStartedAt: 400,
    })
    expect(result).toEqual({ tier: 'free', status: 'expired' })
    expect(tables.subscriptions[0].status).toBe('expired')
  })

  it('looks up legacy ownership from verified store identifiers, not client input', async () => {
    const runQuery = vi.fn(async () => ({ alreadyVerifiedForUser: false }))
    const actionCtx = {
      runQuery,
      runAction: vi.fn(async () => ({
        ...purchase,
        storeState: 'active',
        storeEnvironment: 'Production',
      })),
      runMutation: vi.fn(),
    } as unknown as ActionCtx
    await expect(
      handler<ActionCtx>(verifyStorePurchase)(actionCtx, {
        platform: 'android',
        storeProductId: purchase.storeProductId,
        storeOriginalTransactionId: 'forged-owned-lookup',
        storePurchaseToken: 'real-token',
      }),
    ).rejects.toThrow(/binding/)
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      userId: 'buyer',
      kind: 'subscription',
      storeOriginalTransactionId: 'real-token',
      storePurchaseToken: 'real-token',
    })
  })
})
