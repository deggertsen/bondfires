import { getCatalogFailure, type loadSubscriptionCatalog } from './subscriptionIapCatalog'
import {
  buildIapCatalogTelemetryData,
  type IapCatalogAttemptPhase,
  type IapCatalogFailure,
  type IapCatalogReconnectStatus,
  loadIapCatalogWithRecovery,
} from './subscriptionIapPolicy'

type Catalog<T extends { id: string }> = Awaited<ReturnType<typeof loadSubscriptionCatalog<T>>>
type CatalogTelemetry = ReturnType<typeof buildIapCatalogTelemetryData>

interface CatalogAttemptInput<T extends { id: string }> {
  phase: IapCatalogAttemptPhase
  platform: string
  requestedSubscriptionProductIds: readonly string[]
  isActive: () => boolean
  connection: {
    ensureConnected: () => Promise<void>
    reconnect: () => Promise<void>
  }
  loadCatalog: () => Promise<Catalog<T>>
  onLoaded: (catalog: Catalog<T>) => void
  telemetry: Record<
    'warn' | 'info',
    (event: string, message: string, data: CatalogTelemetry) => void
  >
}

const CANCELLED = Symbol('IAP_CATALOG_ATTEMPT_CANCELLED')

/** Own the attempt's lifecycle and diagnostics, including its single recovery. */
export async function runSubscriptionCatalogAttempt<T extends { id: string }>(
  input: CatalogAttemptInput<T>,
) {
  let reconnectStatus: IapCatalogReconnectStatus = 'not_attempted'
  let stage: 'connection' | 'fetch' | 'reconnect' | 'reload' = 'connection'
  let recoveryCause: IapCatalogFailure | undefined

  function assertActive() {
    if (!input.isActive()) throw CANCELLED
  }

  function report(
    outcome: 'failed' | 'partial' | 'recovered',
    message: string,
    failure: IapCatalogFailure,
  ) {
    input.telemetry[outcome === 'recovered' ? 'info' : 'warn'](
      'iap:catalog',
      message,
      buildIapCatalogTelemetryData({
        ...failure,
        phase: input.phase,
        platform: input.platform,
        requestedSubscriptionProductIds: input.requestedSubscriptionProductIds,
        stage,
        outcome,
        reconnectStatus,
        recoveryCause,
      }),
    )
  }

  try {
    assertActive()
    await input.connection.ensureConnected()
    const result = await loadIapCatalogWithRecovery({
      platform: input.platform,
      loadCatalog: () => {
        // Recheck after both initial connection and recovery: teardown can
        // happen while either native transition is still in flight.
        assertActive()
        stage = reconnectStatus === 'succeeded' ? 'reload' : 'fetch'
        return input.loadCatalog()
      },
      onRecovery: (error, catalog) => {
        recoveryCause = catalog
          ? {
              error,
              failureKind: 'optional_fetch_rejected',
              returnedProductIds: catalog.returnedProductIds,
              missingSubscriptionProductIds: catalog.missingSubscriptionProductIds,
            }
          : getCatalogFailure(error)
      },
      getRecoveryError: (error) => getCatalogFailure(error).error,
      getRecoveryErrorFromResult: (catalog) => catalog.optionalProductError,
      reconnect: async () => {
        assertActive()
        stage = 'reconnect'
        reconnectStatus = 'failed'
        await input.connection.reconnect()
        reconnectStatus = 'succeeded'
      },
    })
    assertActive()
    input.onLoaded(result)

    if (result.optionalProductError !== undefined || result.missingSubscriptionProductIds.length) {
      report('partial', 'IAP catalog loaded partially', {
        error:
          result.optionalProductError ??
          new Error(
            `The store omitted ${result.missingSubscriptionProductIds.length} requested subscription products.`,
          ),
        failureKind:
          result.optionalProductError !== undefined
            ? 'optional_fetch_rejected'
            : 'partial_subscription_catalog',
        returnedProductIds: result.returnedProductIds,
        missingSubscriptionProductIds: result.missingSubscriptionProductIds,
      })
    } else if (recoveryCause) {
      report('recovered', 'IAP catalog loaded after reconnect', {
        error: recoveryCause.error,
        failureKind: recoveryCause.failureKind,
        returnedProductIds: result.returnedProductIds,
        missingSubscriptionProductIds: result.missingSubscriptionProductIds,
      })
    }
  } catch (error) {
    if (error === CANCELLED || !input.isActive()) return
    const failure = getCatalogFailure(error)
    report(
      'failed',
      failure.failureKind === 'empty_subscription_catalog'
        ? 'IAP_EMPTY_SUBSCRIPTION_CATALOG: Store returned no subscription products'
        : 'Failed to load IAP catalog',
      failure,
    )
    throw error
  }
}
