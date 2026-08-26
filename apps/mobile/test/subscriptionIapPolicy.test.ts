import { describe, expect, it } from 'vitest'
import {
  buildIapCatalogTelemetryData,
  isBillingClientNotReadyError,
  isUserCancelledPurchase,
  loadIapCatalogWithRecovery,
  serializeIapError,
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
    expect(isBillingClientNotReadyError(new Error('query-product: Billing client not ready'))).toBe(
      true,
    )
  })

  it('does not retry unrelated catalog failures', () => {
    expect(
      isBillingClientNotReadyError({ code: 'network-error', message: 'Billing client not ready' }),
    ).toBe(false)
    expect(
      isBillingClientNotReadyError({ code: 'query-product', message: 'Product is unavailable' }),
    ).toBe(false)
  })

  it('bounds Android recovery to one reconnect and two catalog loads', async () => {
    let loadCount = 0
    let reconnectCount = 0
    const readinessError = Object.assign(new Error('Billing client not ready'), {
      code: 'query-product',
    })

    await expect(
      loadIapCatalogWithRecovery({
        platform: 'android',
        loadCatalog: async () => {
          loadCount += 1
          throw readinessError
        },
        reconnect: async () => {
          reconnectCount += 1
        },
      }),
    ).rejects.toBe(readinessError)
    expect(loadCount).toBe(2)
    expect(reconnectCount).toBe(1)
  })

  it('recovers when the optional product query reports the readiness race', async () => {
    let loadCount = 0
    let reconnectCount = 0
    const result = await loadIapCatalogWithRecovery({
      platform: 'android',
      loadCatalog: async () => {
        loadCount += 1
        return {
          optionalError:
            loadCount === 1
              ? { code: 'query-product', message: 'Billing client not ready' }
              : undefined,
        }
      },
      getRecoveryErrorFromResult: (catalog) => catalog.optionalError,
      reconnect: async () => {
        reconnectCount += 1
      },
    })

    expect(result.optionalError).toBeUndefined()
    expect(loadCount).toBe(2)
    expect(reconnectCount).toBe(1)
  })

  it('does not reconnect on iOS or for unrelated Android failures', async () => {
    let reconnectCount = 0
    const reconnect = async () => {
      reconnectCount += 1
    }

    await expect(
      loadIapCatalogWithRecovery({
        platform: 'ios',
        loadCatalog: async () => {
          throw { code: 'query-product', message: 'Billing client not ready' }
        },
        reconnect,
      }),
    ).rejects.toBeDefined()
    await expect(
      loadIapCatalogWithRecovery({
        platform: 'android',
        loadCatalog: async () => {
          throw { code: 'network-error', message: 'Request failed' }
        },
        reconnect,
      }),
    ).rejects.toBeDefined()
    expect(reconnectCount).toBe(0)
  })
})

describe('IAP catalog telemetry', () => {
  it('summarizes one catalog attempt with requested and returned products', () => {
    expect(
      buildIapCatalogTelemetryData({
        phase: 'manual_retry',
        platform: 'android',
        requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
        returnedProductIds: ['plus.monthly', 'kindling.3pack'],
        missingSubscriptionProductIds: ['plus.annual'],
        reconnectStatus: 'succeeded',
        error: { code: 'query-product', message: 'Billing client not ready' },
      }),
    ).toEqual({
      phase: 'manual_retry',
      platform: 'android',
      requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
      requestedSubscriptionProductCount: 2,
      returnedProductIds: ['plus.monthly', 'kindling.3pack'],
      returnedProductCount: 2,
      missingSubscriptionProductIds: ['plus.annual'],
      missingSubscriptionProductCount: 1,
      reconnectStatus: 'succeeded',
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
