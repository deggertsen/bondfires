/**
 * Error utility for surfacing Convex errors consistently across the app.
 *
 * Convex wraps server-side `throw new Error(...)` into `ConvexError` on the client.
 * Network/fetch failures surface as native `TypeError` with messages like
 * "Network request failed" — we detect those separately for a retry UX.
 */

/** Support email used for error reporting. */
export const SUPPORT_EMAIL = 'support@bondfires.org'

/** Structured error info extracted from a caught error. */
export interface ErrorInfo {
  /** Human-readable message, never empty. */
  message: string
  /** Whether this is a network/fetch error (user should retry). */
  isNetworkError: boolean
  /** Whether the error originated from a Convex server function. */
  isConvexError: boolean
  /** Raw original error for logging/debugging. */
  originalError: unknown
}

/** Extract a human-readable error message from any caught value. */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || 'Something went wrong'
  }
  if (typeof error === 'string') {
    return error || 'Something went wrong'
  }
  return 'Something went wrong'
}

/** Determine if the error is a network/fetch failure. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return (
      msg.includes('network request failed') ||
      msg.includes('failed to fetch') ||
      msg.includes('network error') ||
      msg.includes('internet connection') ||
      msg.includes('timeout') ||
      msg.includes('abort') ||
      msg.includes('offline')
    )
  }
  return false
}

/** Determine if the error is a ConvexError. */
export function isConvexError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  // ConvexError sets name = "ConvexError" on the client
  const err = error as unknown as Record<string, unknown>
  if (err.name === 'ConvexError') return true
  // ConvexError has a unique symbol
  const convexSymbol = Symbol.for('ConvexError')
  return convexSymbol in (error as unknown as Record<string | symbol, unknown>)
}

/**
 * Parse any caught error into structured ErrorInfo.
 * Never throws — always returns a valid ErrorInfo with a message.
 */
export function parseError(error: unknown): ErrorInfo {
  const network = isNetworkError(error)
  const convex = !network && isConvexError(error)
  const message = extractErrorMessage(error)

  return {
    message,
    isNetworkError: network,
    isConvexError: convex,
    originalError: error,
  }
}

/**
 * Get a user-facing error message string from any caught error.
 * Convenience wrapper around extractErrorMessage — returns the Convex/server message
 * when available, "No internet connection" for network errors, or a generic fallback.
 */
export function getErrorMessage(error: unknown): string {
  if (isNetworkError(error)) return 'No internet connection'
  return extractErrorMessage(error)
}

/**
 * Build a support email mailto: URL with pre-filled error details.
 * Convenience alias for buildErrorReportMailto with the standard support email.
 */
export function buildSupportEmail(
  error: unknown,
  context?: { userId?: string; bondfireId?: string },
): string {
  return buildErrorReportMailto({
    error,
    userId: context?.userId,
    context:
      [
        context?.bondfireId && `bondfireId:${context.bondfireId}`,
        context?.userId && `userId:${context.userId}`,
      ]
        .filter(Boolean)
        .join(', ') || undefined,
  })
}

/**
 * Build a mailto: URL for reporting an error to support.
 * Pre-fills the error message, userId, and timestamp so support has context.
 */
export function buildErrorReportMailto(params: {
  error: unknown
  userId?: string | null
  context?: string
}): string {
  const info = parseError(params.error)

  const subject = encodeURIComponent(`Bug Report: ${info.message.slice(0, 80)}`)

  const bodyLines = [
    `Error: ${info.message}`,
    `Type: ${info.isNetworkError ? 'Network' : info.isConvexError ? 'Convex' : 'Client'}`,
  ]

  if (params.userId) {
    bodyLines.push(`User ID: ${params.userId}`)
  }

  if (params.context) {
    bodyLines.push(`Context: ${params.context}`)
  }

  bodyLines.push(`Timestamp: ${new Date().toISOString()}`)
  bodyLines.push('')
  bodyLines.push('--- Describe what you were doing when the error occurred: ---')

  const body = encodeURIComponent(bodyLines.join('\n'))

  return `mailto:support@bondfires.org?subject=${subject}&body=${body}`
}
