import { describe, expect, it } from 'vitest'
import {
  appleVerificationIdentifiers,
  assertStoreAccountOwnership,
  boundedReconciliationLimit,
  canClaimStoreEvent,
  canUseStoreRecordForUser,
  mapAppleSubscriptionState,
  mapGoogleSubscriptionState,
  matchesAppleOriginalTransaction,
  nextStoreSyncAt,
  parseGooglePubSubEnvelope,
  selectStoreRecordForUser,
  validateAppleApplication,
} from './storeBillingPolicy'

const NOW = Date.UTC(2026, 7, 31)

describe('Apple subscription lifecycle', () => {
  it('maps renewal, cancellation at period end, grace, expiry, refund, and revocation', () => {
    expect(
      mapAppleSubscriptionState({
        status: 1,
        expiresDate: NOW + 1_000,
        autoRenewStatus: 1,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'active', willRenew: true })
    expect(
      mapAppleSubscriptionState({
        status: 1,
        expiresDate: NOW + 1_000,
        autoRenewStatus: 0,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'canceled', willRenew: false })
    expect(
      mapAppleSubscriptionState({ status: 4, gracePeriodExpiresDate: NOW + 1_000, now: NOW }),
    ).toMatchObject({ status: 'active', storeState: 'grace_period' })
    expect(mapAppleSubscriptionState({ status: 2, now: NOW })).toMatchObject({
      status: 'expired',
      storeState: 'expired',
    })
    expect(mapAppleSubscriptionState({ status: 5, now: NOW })).toMatchObject({
      status: 'expired',
      storeState: 'revoked',
    })
    expect(mapAppleSubscriptionState({ status: 1, refunded: true, now: NOW })).toMatchObject({
      status: 'expired',
      storeState: 'refunded',
    })
  })

  it('fails closed on environment, bundle, and production app ID mismatch', () => {
    const expected = {
      environment: 'Production' as const,
      bundleId: 'org.bondfires',
      appAppleId: 1,
    }
    expect(() =>
      validateAppleApplication(expected, {
        environment: 'Sandbox',
        bundleId: 'org.bondfires',
        appAppleId: 1,
      }),
    ).toThrow('environment')
    expect(() =>
      validateAppleApplication(expected, {
        environment: 'Production',
        bundleId: 'wrong',
        appAppleId: 1,
      }),
    ).toThrow('bundle')
    expect(() =>
      validateAppleApplication(expected, {
        environment: 'Production',
        bundleId: 'org.bondfires',
        appAppleId: 2,
      }),
    ).toThrow('app ID')
  })

  it('keeps a renewal lookup transaction distinct from its original transaction', () => {
    const renewalTransactionId = 'renewal-transaction-2'
    const originalTransactionId = 'original-transaction-1'

    expect(renewalTransactionId).not.toBe(originalTransactionId)
    expect(
      appleVerificationIdentifiers({
        storeTransactionId: renewalTransactionId,
        storeOriginalTransactionId: originalTransactionId,
      }),
    ).toEqual({
      transactionId: renewalTransactionId,
      expectedOriginalTransactionId: originalTransactionId,
    })
    expect(matchesAppleOriginalTransaction(originalTransactionId, originalTransactionId)).toBe(true)
    expect(matchesAppleOriginalTransaction(renewalTransactionId, originalTransactionId)).toBe(false)
    expect(matchesAppleOriginalTransaction(undefined, originalTransactionId)).toBe(true)
  })
})

describe('Google subscription lifecycle', () => {
  it('maps renew, cancel, grace, hold, pause, expiry, and revoke without early cancel', () => {
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        expiryTime: NOW + 1_000,
        autoRenewEnabled: true,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'active' })
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        expiryTime: NOW + 1_000,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'canceled' })
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        expiryTime: NOW + 1_000,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'grace_period' })
    expect(
      mapGoogleSubscriptionState({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD', now: NOW }),
    ).toMatchObject({ status: 'past_due', storeState: 'on_hold' })
    expect(
      mapGoogleSubscriptionState({ subscriptionState: 'SUBSCRIPTION_STATE_PAUSED', now: NOW }),
    ).toMatchObject({ status: 'past_due', storeState: 'paused' })
    expect(
      mapGoogleSubscriptionState({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', now: NOW }),
    ).toMatchObject({ status: 'expired', storeState: 'expired' })
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        autoRenewEnabled: true,
        notificationType: 12,
        now: NOW,
      }),
    ).toMatchObject({ status: 'active', storeState: 'active' })
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        notificationType: 12,
        now: NOW,
      }),
    ).toMatchObject({ status: 'expired', storeState: 'revoked' })
    expect(
      mapGoogleSubscriptionState({
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        refunded: true,
        now: NOW,
      }),
    ).toMatchObject({ status: 'expired', storeState: 'refunded' })
  })

  it('rejects malformed, unsupported, and wrong-package Pub/Sub data', () => {
    expect(() => parseGooglePubSubEnvelope({}, 'org.bondfires')).toThrow('Malformed')
    const envelope = (payload: unknown) => ({
      message: {
        messageId: 'message-1',
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      },
    })
    expect(() =>
      parseGooglePubSubEnvelope(
        envelope({ version: '1.0', packageName: 'wrong' }),
        'org.bondfires',
      ),
    ).toThrow('package')
    expect(() =>
      parseGooglePubSubEnvelope(
        envelope({ version: '1.0', packageName: 'org.bondfires' }),
        'org.bondfires',
      ),
    ).toThrow('Unsupported')
  })

  it('decodes a valid subscription notification envelope', () => {
    const rtdn = {
      version: '1.0',
      packageName: 'org.bondfires',
      eventTimeMillis: String(NOW),
      subscriptionNotification: {
        version: '1.0',
        notificationType: 2,
        purchaseToken: 'opaque-token',
        subscriptionId: 'bondfires.pro.monthly',
      },
    }
    const parsed = parseGooglePubSubEnvelope(
      {
        message: {
          messageId: 'message-1',
          data: Buffer.from(JSON.stringify(rtdn)).toString('base64'),
        },
      },
      'org.bondfires',
    )

    expect(parsed).toEqual({ messageId: 'message-1', rtdn })
  })

  it('decodes a valid voided subscription purchase envelope', () => {
    const rtdn = {
      version: '1.0',
      packageName: 'org.bondfires',
      voidedPurchaseNotification: {
        purchaseToken: 'opaque-token',
        orderId: 'order-1',
        productType: 1,
        refundType: 1,
      },
    }
    const parsed = parseGooglePubSubEnvelope(
      {
        message: {
          messageId: 'message-2',
          data: Buffer.from(JSON.stringify(rtdn)).toString('base64'),
        },
      },
      'org.bondfires',
    )

    expect(parsed).toEqual({ messageId: 'message-2', rtdn })
  })
})

describe('billing replay and reconciliation policy', () => {
  it('leases processing events, retries failures, and never replays completed events', () => {
    expect(canClaimStoreEvent(null, NOW)).toBe(true)
    expect(canClaimStoreEvent({ status: 'failed', lastAttemptAt: NOW }, NOW)).toBe(true)
    expect(canClaimStoreEvent({ status: 'processed', lastAttemptAt: NOW }, NOW)).toBe(false)
    expect(canClaimStoreEvent({ status: 'processing', lastAttemptAt: NOW }, NOW)).toBe(false)
    expect(
      canClaimStoreEvent({ status: 'processing', lastAttemptAt: NOW - 5 * 60 * 1_000 }, NOW),
    ).toBe(true)
  })

  it('bounds reconciliation batches', () => {
    expect(boundedReconciliationLimit(-1)).toBe(1)
    expect(boundedReconciliationLimit(25)).toBe(25)
    expect(boundedReconciliationLimit(500)).toBe(50)
  })

  it('uses state-aware schedules and caps failure backoff', () => {
    expect(nextStoreSyncAt(NOW, 'billing_retry')).toBe(NOW + 60 * 60 * 1_000)
    expect(nextStoreSyncAt(NOW, 'active')).toBe(NOW + 12 * 60 * 60 * 1_000)
    expect(nextStoreSyncAt(NOW, 'active', 1)).toBe(NOW + 60 * 60 * 1_000)
    expect(nextStoreSyncAt(NOW, 'active', 20)).toBe(NOW + 24 * 60 * 60 * 1_000)
  })

  it('requires store account binding unless ownership was previously verified', () => {
    expect(() =>
      assertStoreAccountOwnership({
        expectedAccountToken: 'expected',
        verifiedAccountToken: 'other',
        alreadyVerifiedForUser: false,
      }),
    ).toThrow('mismatch')
    expect(() =>
      assertStoreAccountOwnership({
        expectedAccountToken: 'expected',
        alreadyVerifiedForUser: false,
      }),
    ).toThrow('missing')
    expect(() =>
      assertStoreAccountOwnership({
        expectedAccountToken: 'expected',
        alreadyVerifiedForUser: true,
      }),
    ).not.toThrow()
  })

  it("does not let an unverified client claim poison another user's store identifier", () => {
    expect(
      canUseStoreRecordForUser({
        recordUserId: 'attacker',
        requestedUserId: 'owner',
        verificationStatus: 'pending',
      }),
    ).toBe(false)
    expect(
      canUseStoreRecordForUser({
        recordUserId: 'attacker',
        requestedUserId: 'owner',
        verificationStatus: 'verified',
      }),
    ).toBe(true)
    expect(
      canUseStoreRecordForUser({
        recordUserId: 'owner',
        requestedUserId: 'owner',
        verificationStatus: 'pending',
      }),
    ).toBe(true)
    expect(
      selectStoreRecordForUser(
        [
          { userId: 'owner', verificationStatus: 'pending' as const },
          { userId: 'other', verificationStatus: 'verified' as const },
        ],
        'owner',
      ),
    ).toMatchObject({ userId: 'other', verificationStatus: 'verified' })
  })
})
