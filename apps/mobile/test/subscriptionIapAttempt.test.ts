import { describe, expect, it, vi } from 'vitest'
import { runSubscriptionCatalogAttempt } from '../../../packages/app/src/utils/subscriptionIapAttempt'
import { loadSubscriptionCatalog } from '../../../packages/app/src/utils/subscriptionIapCatalog'

const subscriptionProductIds = ['plus.monthly', 'plus.annual']
const subscriptions = subscriptionProductIds.map((id) => ({ id }))
const kindling = [{ id: 'kindling.3pack' }]
const nativeError = { code: 'query-product', description: 'StoreKit request failed' }

function setup(platform = 'ios') {
  const fetchProducts = vi.fn(async ({ type }: { type: 'subs' | 'in-app' }) =>
    type === 'subs' ? subscriptions : kindling,
  )
  const connection = {
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
  }
  const onLoaded = vi.fn()
  const telemetry = { warn: vi.fn(), info: vi.fn() }
  const isActive = vi.fn(() => true)
  const run = () =>
    runSubscriptionCatalogAttempt({
      phase: 'manual_retry',
      platform,
      requestedSubscriptionProductIds: subscriptionProductIds,
      isActive,
      connection,
      loadCatalog: () =>
        loadSubscriptionCatalog({
          fetchProducts,
          subscriptionProductIds,
          inAppProductIds: kindling.map(({ id }) => id),
        }),
      onLoaded,
      telemetry,
    })
  return { fetchProducts, connection, onLoaded, telemetry, isActive, run }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('subscription catalog attempt', () => {
  it('publishes a healthy catalog without a warning or reconnect', async () => {
    const attempt = setup()
    await attempt.run()
    expect(attempt.onLoaded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ products: [...subscriptions, ...kindling] }),
    )
    expect(attempt.connection.reconnect).not.toHaveBeenCalled()
    expect(attempt.telemetry.warn).not.toHaveBeenCalled()
    expect(attempt.telemetry.info).not.toHaveBeenCalled()
  })

  it('publishes recovered subscriptions and emits one informational outcome', async () => {
    const attempt = setup()
    attempt.fetchProducts.mockResolvedValueOnce([])
    await attempt.run()
    expect(attempt.onLoaded).toHaveBeenCalledTimes(1)
    expect(attempt.connection.reconnect).toHaveBeenCalledTimes(1)
    expect(attempt.telemetry.warn).not.toHaveBeenCalled()
    expect(attempt.telemetry.info).toHaveBeenCalledExactlyOnceWith(
      'iap:catalog',
      'IAP catalog loaded after reconnect',
      expect.objectContaining({
        phase: 'manual_retry',
        stage: 'reload',
        outcome: 'recovered',
        reconnectStatus: 'succeeded',
        returnedSubscriptionProductIds: subscriptionProductIds,
        recoveryCause: expect.objectContaining({
          failureKind: 'empty_subscription_catalog',
          returnedProductIds: ['kindling.3pack'],
          missingSubscriptionProductIds: subscriptionProductIds,
        }),
      }),
    )
  })

  it('reports persistent emptiness once and rejects without publishing products', async () => {
    const attempt = setup()
    attempt.fetchProducts.mockImplementation(async ({ type }) => (type === 'subs' ? [] : kindling))
    await expect(attempt.run()).rejects.toThrow('no subscription products')
    expect(attempt.fetchProducts).toHaveBeenCalledTimes(4)
    expect(attempt.onLoaded).not.toHaveBeenCalled()
    expect(attempt.telemetry.warn).toHaveBeenCalledExactlyOnceWith(
      'iap:catalog',
      expect.stringContaining('IAP_EMPTY_SUBSCRIPTION_CATALOG'),
      expect.objectContaining({
        stage: 'reload',
        outcome: 'failed',
        failureKind: 'empty_subscription_catalog',
        returnedSubscriptionProductCount: 0,
        reconnectStatus: 'succeeded',
      }),
    )
  })

  it.each(['connection', 'reconnect', 'reload'] as const)(
    'reports a failure at the %s stage with the original recovery cause',
    async (stage) => {
      const attempt = setup()
      if (stage === 'connection') {
        attempt.connection.ensureConnected.mockRejectedValue(nativeError)
      } else {
        attempt.fetchProducts.mockResolvedValueOnce([])
        if (stage === 'reconnect') {
          attempt.connection.reconnect.mockRejectedValue(nativeError)
        } else {
          attempt.fetchProducts.mockResolvedValueOnce(kindling).mockRejectedValueOnce(nativeError)
        }
      }
      await expect(attempt.run()).rejects.toBeDefined()
      expect(attempt.onLoaded).not.toHaveBeenCalled()
      expect(attempt.telemetry.warn).toHaveBeenCalledExactlyOnceWith(
        'iap:catalog',
        'Failed to load IAP catalog',
        expect.objectContaining({
          stage,
          outcome: 'failed',
          error: nativeError,
          failureKind: stage === 'reload' ? 'fetch_rejected' : 'connection_failed',
          reconnectStatus:
            stage === 'connection'
              ? 'not_attempted'
              : stage === 'reconnect'
                ? 'failed'
                : 'succeeded',
          ...(stage !== 'connection'
            ? {
                recoveryCause: expect.objectContaining({
                  failureKind: 'empty_subscription_catalog',
                }),
              }
            : {}),
        }),
      )
    },
  )

  it('preserves the Android optional recovery catalog even if reconnect fails', async () => {
    const attempt = setup('android')
    const readinessError = { code: 'query-product', message: 'Billing client not ready' }
    attempt.fetchProducts
      .mockResolvedValueOnce(subscriptions.slice(0, 1))
      .mockRejectedValueOnce(readinessError)
    attempt.connection.reconnect.mockRejectedValue(nativeError)
    await expect(attempt.run()).rejects.toBe(nativeError)
    expect(attempt.telemetry.warn).toHaveBeenCalledExactlyOnceWith(
      'iap:catalog',
      'Failed to load IAP catalog',
      expect.objectContaining({
        stage: 'reconnect',
        recoveryCause: expect.objectContaining({
          error: readinessError,
          failureKind: 'optional_fetch_rejected',
          returnedProductIds: [subscriptionProductIds[0]],
          missingSubscriptionProductIds: [subscriptionProductIds[1]],
        }),
      }),
    )
  })

  it('reports a partial reload as one warning with recovery context', async () => {
    const attempt = setup()
    attempt.fetchProducts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(kindling)
      .mockResolvedValueOnce(subscriptions.slice(0, 1))
    await attempt.run()
    expect(attempt.onLoaded).toHaveBeenCalledTimes(1)
    expect(attempt.telemetry.info).not.toHaveBeenCalled()
    expect(attempt.telemetry.warn).toHaveBeenCalledExactlyOnceWith(
      'iap:catalog',
      'IAP catalog loaded partially',
      expect.objectContaining({
        stage: 'reload',
        outcome: 'partial',
        failureKind: 'partial_subscription_catalog',
        recoveryCause: expect.objectContaining({ failureKind: 'empty_subscription_catalog' }),
      }),
    )
  })

  it.each(['connection', 'fetch', 'reconnect'] as const)(
    'stops an attempt deactivated during %s without starting more queries',
    async (stage) => {
      const attempt = setup()
      const started = deferred()
      const pending = deferred()
      const wait = async () => {
        started.resolve()
        await pending.promise
      }
      if (stage === 'connection') {
        attempt.connection.ensureConnected.mockImplementation(wait)
      } else if (stage === 'fetch') {
        attempt.fetchProducts.mockImplementationOnce(async () => {
          await wait()
          return []
        })
      } else {
        attempt.fetchProducts.mockResolvedValueOnce([])
        attempt.connection.reconnect.mockImplementation(wait)
      }
      const running = attempt.run()
      await started.promise
      attempt.isActive.mockReturnValue(false)
      pending.resolve()
      await running
      expect(attempt.fetchProducts).toHaveBeenCalledTimes(stage === 'connection' ? 0 : 2)
      expect(attempt.connection.reconnect).toHaveBeenCalledTimes(stage === 'reconnect' ? 1 : 0)
      expect(attempt.onLoaded).not.toHaveBeenCalled()
      expect(attempt.telemetry.warn).not.toHaveBeenCalled()
      expect(attempt.telemetry.info).not.toHaveBeenCalled()
    },
  )
})
