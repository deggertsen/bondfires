function getErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const value = (error as Record<string, unknown>).code
  return typeof value === 'string' ? value : undefined
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
