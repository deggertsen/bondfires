/**
 * Error utility for surfacing Convex errors consistently across the app.
 *
 * Convex application errors carry user-facing messages in `ConvexError.data`.
 * Network/fetch failures surface as native `TypeError` with messages like
 * "Network request failed" — we detect those separately for a retry UX.
 */

/** Support email used for error reporting. */
export const SUPPORT_EMAIL = 'support@bondfires.org'
export const NETWORK_ERROR_MESSAGE = 'Check your connection and try again.'

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

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractConvexErrorDataMessage(error: unknown): string | undefined {
  if (!isRecord(error) || !('data' in error)) {
    return undefined
  }

  const data = error.data
  if (typeof data === 'string' && data.trim().length > 0) {
    return data
  }

  if (isRecord(data) && typeof data.message === 'string' && data.message.trim().length > 0) {
    return data.message
  }

  return undefined
}

function extractThrownErrorMessage(error: Error): string {
  const lines = error.message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const uncaughtLine = lines.find((line) => line.startsWith('Uncaught Error: '))

  if (uncaughtLine) {
    return uncaughtLine.replace(/^Uncaught Error:\s*/, '')
  }

  return error.message || 'Something went wrong'
}

/** Extract a human-readable error message from any caught value. */
export function extractErrorMessage(error: unknown): string {
  const convexMessage = extractConvexErrorDataMessage(error)
  if (convexMessage) {
    return convexMessage
  }

  if (error instanceof Error) {
    return extractThrownErrorMessage(error)
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
  if (!isRecord(error)) return false
  // ConvexError sets name = "ConvexError" on the client
  if (error.name === 'ConvexError') return true
  // ConvexError application payloads are exposed as `data`.
  if ('data' in error && error.data !== undefined) return true
  // ConvexError has a unique symbol
  const convexSymbol = Symbol.for('ConvexError')
  return convexSymbol in error
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

export function getUserFacingErrorMessage(errorInfo: ErrorInfo): string {
  return errorInfo.isNetworkError ? NETWORK_ERROR_MESSAGE : errorInfo.message
}

export function shouldShowReportIssue(errorInfo: ErrorInfo): boolean {
  return !errorInfo.isNetworkError && !errorInfo.isConvexError
}

export function getAuthErrorMessage(error: unknown): string {
  const errorInfo = parseError(error)
  if (errorInfo.isNetworkError) {
    return NETWORK_ERROR_MESSAGE
  }

  const message = errorInfo.message.trim()
  const normalized = message.toLowerCase()

  if (
    (normalized.includes('invalid') || normalized.includes('expired')) &&
    (normalized.includes('code') ||
      normalized.includes('token') ||
      normalized.includes('verification') ||
      normalized.includes('otp'))
  ) {
    return 'That code is invalid or expired. Request a new code and try again.'
  }

  if (
    normalized.includes('too many') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate-limit')
  ) {
    return 'Too many attempts. Please wait a moment and try again.'
  }

  if (
    normalized.includes('already exists') ||
    normalized.includes('already in use') ||
    normalized.includes('email is taken')
  ) {
    return 'An account with this email already exists.'
  }

  if (normalized.includes('invalid email') || normalized.includes('email is invalid')) {
    return 'Enter a valid email address.'
  }

  if (
    normalized.includes('weak password') ||
    normalized.includes('password is too short') ||
    normalized.includes('password must')
  ) {
    return 'Choose a stronger password.'
  }

  if (
    normalized.includes('invalid credentials') ||
    normalized.includes('incorrect password') ||
    normalized.includes('wrong password')
  ) {
    return 'Check your email and password and try again.'
  }

  return message || 'Something went wrong. Please try again.'
}

/**
 * Get a user-facing error message string from any caught error.
 * Convenience wrapper around extractErrorMessage — returns the Convex/server message
 * when available, a friendly retry message for network errors, or a generic fallback.
 */
export function getErrorMessage(error: unknown): string {
  return getUserFacingErrorMessage(parseError(error))
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
    bodyLines.push(`Where: ${params.context}`)
  }

  bodyLines.push(`Timestamp: ${new Date().toISOString()}`)
  bodyLines.push('')
  bodyLines.push('--- Describe what you were doing when the error occurred: ---')

  const body = encodeURIComponent(bodyLines.join('\n'))

  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`
}
