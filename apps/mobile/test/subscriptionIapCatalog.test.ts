import { describe, expect, it, vi } from 'vitest'
import {
  ALL_SUBSCRIPTION_PRODUCT_IDS,
  KINDLING_PACK_PRODUCT_IDS,
} from '../../../packages/app/src/store/subscription.store'
import {
  getCatalogFailure,
  loadSubscriptionCatalog,
} from '../../../packages/app/src/utils/subscriptionIapCatalog'
import {
  buildIapCatalogTelemetryData,
  type IapCatalogFailure,
  loadIapCatalogWithRecovery,
} from '../../../packages/app/src/utils/subscriptionIapPolicy'

vi.mock('@legendapp/state/sync', () => ({ syncObservable: vi.fn() }))

const subscriptions = ALL_SUBSCRIPTION_PRODUCT_IDS.map((id) => ({ id }))
const kindling = Object.values(KINDLING_PACK_PRODUCT_IDS).map((id) => ({ id }))
const catalogIds = {
  subscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
  inAppProductIds: Object.values(KINDLING_PACK_PRODUCT_IDS),
}

function recoverCatalog(
  fetchProducts: Parameters<typeof loadSubscriptionCatalog>[0]['fetchProducts'],
) {
  const reconnect = vi.fn().mockResolvedValue(undefined)
  const onRecovery = vi.fn()
  const loadCatalog = vi.fn(() => loadSubscriptionCatalog({ ...catalogIds, fetchProducts }))
  const promise = loadIapCatalogWithRecovery({
    platform: 'ios',
    loadCatalog,
    reconnect,
    onRecovery,
    getRecoveryError: (error) => getCatalogFailure(error).error,
    getRecoveryErrorFromResult: (result) => result.optionalProductError,
  })
  return { promise, loadCatalog, reconnect, onRecovery }
}

describe('subscription catalog queries', () => {
  it('retries an empty subscription query even when kindling products resolve', async () => {
    let subscriptionCalls = 0
    const fetchProducts = vi.fn(async ({ type }: { type: string }) => {
      if (type === 'in-app') return kindling
      subscriptionCalls += 1
      return subscriptionCalls === 1 ? [] : subscriptions
    })
    const attempt = recoverCatalog(fetchProducts)

    const result = await attempt.promise
    expect(result.products).toEqual([...subscriptions, ...kindling])
    expect(result.missingSubscriptionProductIds).toEqual([])
    expect(attempt.loadCatalog).toHaveBeenCalledTimes(2)
    expect(attempt.reconnect).toHaveBeenCalledTimes(1)
    expect(attempt.onRecovery).toHaveBeenCalledTimes(1)
    expect(fetchProducts).toHaveBeenCalledWith({ skus: ALL_SUBSCRIPTION_PRODUCT_IDS, type: 'subs' })
    expect(fetchProducts).toHaveBeenCalledWith({ skus: catalogIds.inAppProductIds, type: 'in-app' })
  })

  it.each([[], null])(
    'surfaces a persistent empty response (%j) with actionable telemetry',
    async (empty) => {
      const attempt = recoverCatalog(async ({ type }) => (type === 'subs' ? empty : kindling))
      const error = await attempt.promise.catch((failure: unknown) => failure)
      const failure = getCatalogFailure(error)
      const recoveryCause = getCatalogFailure(attempt.onRecovery.mock.calls[0][0])

      expect(attempt.loadCatalog).toHaveBeenCalledTimes(2)
      expect(attempt.reconnect).toHaveBeenCalledTimes(1)
      expect(failure.failureKind).toBe('empty_subscription_catalog')
      const telemetry = buildIapCatalogTelemetryData({
        ...failure,
        recoveryCause,
        phase: 'initial',
        stage: 'reload',
        outcome: 'failed',
        platform: 'ios',
        reconnectStatus: 'succeeded',
        requestedSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
      })
      expect(JSON.parse(JSON.stringify(telemetry))).toMatchObject({
        phase: 'initial',
        stage: 'reload',
        outcome: 'failed',
        failureKind: 'empty_subscription_catalog',
        reconnectStatus: 'succeeded',
        requestedSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
        requestedSubscriptionProductCount: 6,
        returnedProductIds: catalogIds.inAppProductIds,
        returnedSubscriptionProductIds: [],
        returnedSubscriptionProductCount: 0,
        missingSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
        error: { code: 'IAP_EMPTY_SUBSCRIPTION_CATALOG' },
        recoveryCause: {
          failureKind: 'empty_subscription_catalog',
          error: { code: 'IAP_EMPTY_SUBSCRIPTION_CATALOG' },
          returnedProductIds: catalogIds.inAppProductIds,
        },
      })
    },
  )

  it('distinguishes a rejected StoreKit query and preserves its error without reconnecting', async () => {
    const storeKitError = {
      code: 'query-product',
      underlyingErrorMessage: 'StoreKit request failed',
      productId: ALL_SUBSCRIPTION_PRODUCT_IDS[0],
      description: 'Native StoreKit diagnostic',
    }
    const attempt = recoverCatalog(async ({ type }) => {
      if (type === 'subs') throw storeKitError
      return kindling
    })
    const error = await attempt.promise.catch((failure: unknown) => failure)
    const failure = getCatalogFailure(error)
    expect(attempt.loadCatalog).toHaveBeenCalledTimes(1)
    expect(attempt.reconnect).not.toHaveBeenCalled()
    expect(
      buildIapCatalogTelemetryData({
        ...failure,
        phase: 'manual_retry',
        stage: 'fetch',
        outcome: 'failed',
        platform: 'ios',
        reconnectStatus: 'not_attempted',
        requestedSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
      }),
    ).toMatchObject({
      failureKind: 'fetch_rejected',
      error: storeKitError,
      returnedSubscriptionProductCount: 0,
    })
  })

  it('keeps optional native errors when the subscription query is empty', async () => {
    const optionalError = { code: 'query-product', description: 'Kindling query failed' }
    const attempt = recoverCatalog(async ({ type }) => {
      if (type === 'in-app') throw optionalError
      return []
    })
    const error = await attempt.promise.catch((failure: unknown) => failure)
    expect(getCatalogFailure(error)).toMatchObject({
      failureKind: 'empty_subscription_catalog',
      optionalProductError: optionalError,
    })
  })

  it('keeps subscriptions available when only the optional query fails on iOS', async () => {
    const optionalError = { code: 'query-product', description: 'Kindling query failed' }
    const attempt = recoverCatalog(async ({ type }) => {
      if (type === 'in-app') throw optionalError
      return subscriptions
    })
    expect(await attempt.promise).toMatchObject({
      products: subscriptions,
      optionalProductError: optionalError,
    })
    expect(attempt.reconnect).not.toHaveBeenCalled()
  })

  it('does not reconnect for a partial subscription catalog', async () => {
    const attempt = recoverCatalog(async ({ type }) =>
      type === 'subs' ? subscriptions.slice(0, 1) : [],
    )
    expect(await attempt.promise).toMatchObject({
      products: subscriptions.slice(0, 1),
      missingSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS.slice(1),
    })
    expect(attempt.reconnect).not.toHaveBeenCalled()
  })

  it('retains the initial empty response if the reload rejects with a native error', async () => {
    const storeKitError = { code: 'query-product', description: 'Reload rejected' }
    let calls = 0
    let recoveryCause: IapCatalogFailure | undefined
    const loadCatalog = () =>
      loadSubscriptionCatalog({
        ...catalogIds,
        fetchProducts: async ({ type }) => {
          if (type === 'in-app') return kindling
          calls += 1
          if (calls === 1) return []
          throw storeKitError
        },
      })
    const promise = loadIapCatalogWithRecovery({
      platform: 'ios',
      loadCatalog,
      reconnect: async () => {},
      getRecoveryError: (error) => getCatalogFailure(error).error,
      onRecovery: (error) => {
        recoveryCause = getCatalogFailure(error)
      },
    })
    const error = await promise.catch((failure: unknown) => failure)
    expect(getCatalogFailure(error)).toMatchObject({
      failureKind: 'fetch_rejected',
      error: storeKitError,
    })
    expect(recoveryCause).toMatchObject({ failureKind: 'empty_subscription_catalog' })
    expect(calls).toBe(2)
  })
})
