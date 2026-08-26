import { describe, expect, it } from 'vitest'
import {
  buildIapCatalogTelemetryData,
  isBillingClientNotReadyError,
  isUserCancelledPurchase,
  serializeIapError,
  shouldRecoverIapCatalogConnection,
} from '../../../packages/app/src/utils/subscriptionIapPolicy'

describe('isUserCancelledPurchase', () => {
  it('recognizes the native cancellation code without relying on localized copy', () => {
    expect(isUserCancelledPurchase({ code: 'E_USER_CANCELLED' }, 'Operation failed')).toBe(true)
  })

  it('recognizes common cancellation messages from both stores', () => {
    expect(isUserCancelledPurchase({}, 'User cancelled the purchase')).toBe(true)
    expect(isUserCancelledPurchase({}, 'Purchase canceled')).toBe(true)
  })

  it('does not classify unrelated references to cancellation as user cancellations', () => {
    expect(isUserCancelledPurchase({}, 'This subscription cannot be cancelled here')).toBe(false)
    expect(isUserCancelledPurchase({ code: 'E_NETWORK_ERROR' }, 'Purchase failed')).toBe(false)
  })
})

describe('isBillingClientNotReadyError', () => {
  it('recognizes the retryable Google Billing product-query race', () => {
    expect(
      isBillingClientNotReadyError({
        code: 'query-product',
        message: 'Billing client not ready',
      }),
    ).toBe(true)
  })

  it('does not retry unrelated catalog failures', () => {
    expect(
      isBillingClientNotReadyError({ code: 'network-error', message: 'Billing client not ready' }),
    ).toBe(false)
    expect(
      isBillingClientNotReadyError({ code: 'query-product', message: 'Product is unavailable' }),
    ).toBe(false)
  })

  it('bounds Android recovery to one reconnect per catalog attempt', () => {
    const error = { code: 'query-product', message: 'Billing client not ready' }
    expect(shouldRecoverIapCatalogConnection('android', error, false)).toBe(true)
    expect(shouldRecoverIapCatalogConnection('android', error, true)).toBe(false)
    expect(shouldRecoverIapCatalogConnection('ios', error, false)).toBe(false)
  })
})

describe('IAP catalog telemetry', () => {
  it('summarizes one catalog attempt with requested and returned products', () => {
    expect(
      buildIapCatalogTelemetryData({
        phase: 'manual_retry',
        platform: 'android',
        requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
        returnedProductIds: ['plus.monthly'],
        recoveredConnection: true,
        error: { code: 'query-product', message: 'Billing client not ready' },
      }),
    ).toEqual({
      phase: 'manual_retry',
      platform: 'android',
      requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
      requestedSubscriptionProductCount: 2,
      returnedProductIds: ['plus.monthly'],
      returnedProductCount: 1,
      recoveredConnection: true,
      error: { code: 'query-product', message: 'Billing client not ready' },
    })
  })

  it('serializes Error instances without losing their message', () => {
    expect(serializeIapError(new Error('Catalog unavailable'))).toMatchObject({
      name: 'Error',
      message: 'Catalog unavailable',
    })
  })
})
