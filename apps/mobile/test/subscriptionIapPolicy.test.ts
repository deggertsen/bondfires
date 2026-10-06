import { describe, expect, it, vi } from 'vitest'
import {
  buildIapCatalogTelemetryData,
  EmptySubscriptionCatalogError,
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

  it('does not apply the Android readiness recovery to iOS or unrelated failures', async () => {
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
        stage: 'reload',
        outcome: 'partial',
        failureKind: 'optional_fetch_rejected',
        platform: 'android',
        requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
        returnedProductIds: ['plus.monthly', 'kindling.3pack'],
        missingSubscriptionProductIds: ['plus.annual'],
        reconnectStatus: 'succeeded',
        error: { code: 'query-product', message: 'Billing client not ready' },
      }),
    ).toEqual({
      phase: 'manual_retry',
      stage: 'reload',
      outcome: 'partial',
      failureKind: 'optional_fetch_rejected',
      platform: 'android',
      requestedSubscriptionProductIds: ['plus.monthly', 'plus.annual'],
      requestedSubscriptionProductCount: 2,
      returnedProductIds: ['plus.monthly', 'kindling.3pack'],
      returnedProductCount: 2,
      returnedSubscriptionProductIds: ['plus.monthly'],
      returnedSubscriptionProductCount: 1,
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

describe('iOS catalog recovery', () => {
  it('reconnects and reloads once for a transient empty response', async () => {
    const empty = new EmptySubscriptionCatalogError()
    const loadCatalog = vi.fn().mockRejectedValueOnce(empty).mockResolvedValue(['plus.monthly'])
    const reconnect = vi.fn().mockResolvedValue(undefined)
    const onRecovery = vi.fn()

    await expect(
      loadIapCatalogWithRecovery({ platform: 'ios', loadCatalog, reconnect, onRecovery }),
    ).resolves.toEqual(['plus.monthly'])
    expect(loadCatalog).toHaveBeenCalledTimes(2)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(onRecovery).toHaveBeenCalledExactlyOnceWith(empty)
  })

  it('propagates a persistent empty response after exactly one reconnect', async () => {
    const empty = new EmptySubscriptionCatalogError()
    const loadCatalog = vi.fn().mockRejectedValue(empty)
    const reconnect = vi.fn().mockResolvedValue(undefined)

    await expect(
      loadIapCatalogWithRecovery({ platform: 'ios', loadCatalog, reconnect }),
    ).rejects.toBe(empty)
    expect(loadCatalog).toHaveBeenCalledTimes(2)
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('propagates reconnect failure without reloading and retains the recovery cause', async () => {
    const empty = new EmptySubscriptionCatalogError()
    const connectionError = new Error('StoreKit connection failed')
    const loadCatalog = vi.fn().mockRejectedValue(empty)
    const reconnect = vi.fn().mockRejectedValue(connectionError)
    const onRecovery = vi.fn()

    await expect(
      loadIapCatalogWithRecovery({ platform: 'ios', loadCatalog, reconnect, onRecovery }),
    ).rejects.toBe(connectionError)
    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(onRecovery).toHaveBeenCalledExactlyOnceWith(empty)
  })

  it.each(['android', 'web'])('does not recover an empty response on %s', async (platform) => {
    const empty = new EmptySubscriptionCatalogError()
    const loadCatalog = vi.fn().mockRejectedValue(empty)
    const reconnect = vi.fn()

    await expect(loadIapCatalogWithRecovery({ platform, loadCatalog, reconnect })).rejects.toBe(
      empty,
    )
    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('does not recover ordinary StoreKit rejections, including empty-looking messages', async () => {
    const error = { code: 'query-product', message: 'The store returned no subscription products.' }
    const loadCatalog = vi.fn().mockRejectedValue(error)
    const reconnect = vi.fn()

    await expect(
      loadIapCatalogWithRecovery({ platform: 'ios', loadCatalog, reconnect }),
    ).rejects.toBe(error)
    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('preserves StoreKit diagnostic fields on Error instances through JSON serialization', () => {
    const error = Object.assign(new Error('Failed to query products'), {
      code: 'query-product',
      underlyingErrorMessage: 'StoreKit underlying failure',
      productId: 'bondfires.plus.monthly',
      description: 'StoreKit diagnostic description',
    })
    expect(JSON.parse(JSON.stringify(serializeIapError(error)))).toMatchObject({
      message: error.message,
      code: error.code,
      underlyingErrorMessage: error.underlyingErrorMessage,
      productId: error.productId,
      description: error.description,
    })
  })
})
