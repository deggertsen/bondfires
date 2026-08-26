function getErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const value = (error as Record<string, unknown>).code
  return typeof value === 'string' ? value : undefined
}

function getErrorField(error: unknown, field: string) {
  if (!error || typeof error !== 'object' || !(field in error)) return undefined
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

const IAP_ERROR_FIELDS = [
  'name',
  'message',
  'debugMessage',
  'code',
  'responseCode',
  'underlyingErrorMessage',
  'productId',
  'platform',
] as const

/** Convert native IAP errors into a JSON-safe telemetry payload. */
export function serializeIapError(error: unknown): Record<string, unknown> {
  if (error == null) return { value: String(error) }
  if (typeof error === 'string') return { message: error }
  if (typeof error !== 'object') return { value: String(error) }

  const record = error as Record<string, unknown>
  const serialized: Record<string, unknown> = {}
  for (const field of IAP_ERROR_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      serialized[field] = value
    }
  }

  if (error instanceof Error) {
    serialized.name ??= error.name
    serialized.message ??= error.message
    if (error.stack) serialized.stack = error.stack
  }
  if (Object.keys(serialized).length === 0) serialized.message = String(error)
  return serialized
}

/** Google Billing occasionally resolves initialization before product queries are ready. */
export function isBillingClientNotReadyError(error: unknown) {
  const code = getErrorCode(error)?.toLowerCase()
  const message = (
    getErrorField(error, 'message') ??
    getErrorField(error, 'debugMessage') ??
    ''
  ).toLowerCase()
  const isProductQueryError = code === 'query-product' || message.includes('query-product')
  return isProductQueryError && message.includes('billing client not ready')
}

export function shouldRecoverIapCatalogConnection(platform: string, error: unknown) {
  return platform === 'android' && isBillingClientNotReadyError(error)
}

export type IapCatalogAttemptPhase = 'initial' | 'manual_retry'
export type IapCatalogReconnectStatus = 'not_attempted' | 'succeeded' | 'failed'

interface IapCatalogRecoveryInput<T> {
  platform: string
  loadCatalog: () => Promise<T>
  reconnect: () => Promise<void>
  getRecoveryError?: (error: unknown) => unknown
  getRecoveryErrorFromResult?: (result: T) => unknown
}

/** Retry a catalog load exactly once after the Android Billing readiness race. */
export async function loadIapCatalogWithRecovery<T>(input: IapCatalogRecoveryInput<T>) {
  async function reconnectAndReload() {
    await input.reconnect()
    return await input.loadCatalog()
  }

  let result: T
  try {
    result = await input.loadCatalog()
  } catch (error) {
    const recoveryError = input.getRecoveryError?.(error) ?? error
    if (!shouldRecoverIapCatalogConnection(input.platform, recoveryError)) {
      throw error
    }
    return await reconnectAndReload()
  }

  const recoveryError = input.getRecoveryErrorFromResult?.(result)
  if (shouldRecoverIapCatalogConnection(input.platform, recoveryError)) {
    return await reconnectAndReload()
  }
  return result
}

interface IapCatalogTelemetryInput {
  phase: IapCatalogAttemptPhase
  platform: string
  requestedSubscriptionProductIds: readonly string[]
  returnedProductIds: readonly string[]
  missingSubscriptionProductIds?: readonly string[]
  reconnectStatus: IapCatalogReconnectStatus
  error: unknown
}

/** One normalized payload per catalog attempt keeps audit counts actionable. */
export function buildIapCatalogTelemetryData(input: IapCatalogTelemetryInput) {
  return {
    phase: input.phase,
    platform: input.platform,
    requestedSubscriptionProductIds: [...input.requestedSubscriptionProductIds],
    requestedSubscriptionProductCount: input.requestedSubscriptionProductIds.length,
    returnedProductIds: [...input.returnedProductIds],
    returnedProductCount: input.returnedProductIds.length,
    missingSubscriptionProductIds: [...(input.missingSubscriptionProductIds ?? [])],
    missingSubscriptionProductCount: input.missingSubscriptionProductIds?.length ?? 0,
    reconnectStatus: input.reconnectStatus,
    recoveredConnection: input.reconnectStatus === 'succeeded',
    error: serializeIapError(input.error),
  }
}

/** Purchase cancellation is expected user behavior, not an IAP failure. */
export function isUserCancelledPurchase(error: unknown, message: string) {
  const normalizedMessage = message.toLowerCase()
  return (
    getErrorCode(error) === 'E_USER_CANCELLED' ||
    normalizedMessage.includes('user cancelled') ||
    normalizedMessage.includes('user canceled') ||
    normalizedMessage.includes('purchase cancelled') ||
    normalizedMessage.includes('purchase canceled')
  )
}
