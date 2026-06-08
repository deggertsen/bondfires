import { AlertTriangle, RefreshCw, Send } from '@tamagui/lucide-icons'
import { Linking } from 'react-native'
import { YStack } from 'tamagui'
import { Button } from './Button'
import { Text } from './Text'

/** Context passed alongside the error for reporting. */
export interface ErrorContext {
  userId?: string | null
  bondfireId?: string
  [key: string]: unknown
}

export interface ErrorDisplayProps {
  /**
   * The raw caught error. The component derives the message and type from it.
   * If provided, takes precedence over `message` + `isNetworkError`.
   */
  error?: unknown
  /** The error message to display. Used when `error` is not provided. */
  message?: string
  /** Whether this is a network error (shows retry button). */
  isNetworkError?: boolean
  /** Called when the user taps Retry (network errors only). */
  onRetry?: () => void
  /** Called when the user taps Report Issue. If omitted, opens mailto. */
  onReport?: () => void
  /** Pre-built mailto URL. If provided, Report Issue opens this URL. */
  reportUrl?: string
  /** Additional context for error reporting. */
  context?: ErrorContext
  /** If true, shows a compact inline layout instead of a centered card. */
  compact?: boolean
  /** If true, renders nothing — used for cases where error is handled elsewhere. */
  hidden?: boolean
}

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractConvexDataMessage(error: unknown): string | undefined {
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

/**
 * Detect whether an error is a network/fetch failure.
 */
function detectNetworkError(error: unknown): boolean {
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

function detectConvexError(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.name === 'ConvexError') return true
  if ('data' in error && error.data !== undefined) return true
  const convexSymbol = Symbol.for('ConvexError')
  return convexSymbol in error
}

/**
 * Extract a human-readable message from any caught error.
 */
function extractMessage(error: unknown): string {
  const convexMessage = extractConvexDataMessage(error)
  if (convexMessage) {
    return convexMessage
  }

  if (error instanceof Error) {
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
  if (typeof error === 'string') {
    return error || 'Something went wrong'
  }
  return 'Something went wrong'
}

/**
 * Build a mailto URL from the error and optional context.
 */
function buildDefaultReportUrl(message: string, context?: ErrorContext): string {
  const subject = encodeURIComponent(`Bug Report: ${message.slice(0, 80)}`)

  const bodyLines = [`Error: ${message}`]

  if (context?.userId) {
    bodyLines.push(`User ID: ${context.userId}`)
  }
  if (context?.bondfireId) {
    bodyLines.push(`Bondfire ID: ${context.bondfireId}`)
  }

  bodyLines.push(`Timestamp: ${new Date().toISOString()}`)
  bodyLines.push('')
  bodyLines.push('--- Describe what you were doing when the error occurred: ---')

  const body = encodeURIComponent(bodyLines.join('\n'))
  return `mailto:support@bondfires.org?subject=${subject}&body=${body}`
}

/**
 * Reusable error display component.
 *
 * Accepts either a raw `error` object (derives message + type automatically)
 * or explicit `message` + `isNetworkError` props.
 *
 * Shows different UX depending on error type:
 * - Network errors: "No internet connection" message + [Try Again] button
 * - App errors: actual error message
 * - Unexpected errors: actual error message + [Report Issue] button
 *
 * Uses Tamagui components and bondfireColors for visual consistency.
 */
export function ErrorDisplay({
  error,
  message: explicitMessage,
  isNetworkError: explicitIsNetworkError,
  onRetry,
  onReport,
  reportUrl,
  context,
  compact = false,
  hidden = false,
}: ErrorDisplayProps) {
  if (hidden) return null

  // Derive message and network flag from the raw error when provided
  const message = error ? extractMessage(error) : (explicitMessage ?? 'Something went wrong')
  const isNetworkError = error ? detectNetworkError(error) : (explicitIsNetworkError ?? false)
  const isConvexError = error ? detectConvexError(error) : false

  const handleReport = () => {
    if (onReport) {
      onReport()
      return
    }
    const url = reportUrl ?? buildDefaultReportUrl(message, context)
    Linking.openURL(url).catch(() => {
      // Silently fail if mail client isn't available
    })
  }

  const showReportButton =
    !isNetworkError && !isConvexError && (error !== undefined || onReport || reportUrl || !!context)
  const title = isNetworkError
    ? 'No internet connection'
    : isConvexError
      ? 'Action needed'
      : 'Something went wrong'

  const icon = isNetworkError ? (
    <RefreshCw size={24} color={'$warning'} />
  ) : (
    <AlertTriangle size={24} color={'$error'} />
  )

  if (compact) {
    return (
      <YStack gap={8} paddingHorizontal={16} paddingVertical={12}>
        <YStack flexDirection="row" alignItems="flex-start" gap={8}>
          {icon}
          <Text fontSize={14} color={'$placeholderColor'} flexShrink={1} lineHeight={20}>
            {isNetworkError ? 'Check your connection and try again.' : message}
          </Text>
        </YStack>
        {isNetworkError && onRetry ? (
          <Button variant="secondary" size="$sm" marginTop={4} onPress={onRetry}>
            Try Again
          </Button>
        ) : showReportButton ? (
          <Button
            variant="ghost"
            size="$sm"
            marginTop={4}
            icon={<Send size={14} color={'$placeholderColor'} />}
            onPress={handleReport}
          >
            Report Issue
          </Button>
        ) : null}
      </YStack>
    )
  }

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      gap={16}
      paddingHorizontal={24}
      paddingVertical={32}
    >
      {icon}
      <YStack gap={4} alignItems="center">
        <Text fontSize={16} fontWeight="600" color={'$color'} textAlign="center">
          {title}
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={20}>
          {isNetworkError ? 'Check your connection and try again.' : message}
        </Text>
      </YStack>
      <YStack gap={8} width="100%" maxWidth={280}>
        {isNetworkError && onRetry ? (
          <Button
            icon={<RefreshCw size={16} color={'$color'} />}
            variant="primary"
            size="$md"
            onPress={onRetry}
          >
            Try Again
          </Button>
        ) : null}
        {showReportButton ? (
          <Button
            icon={<Send size={16} color={'$placeholderColor'} />}
            variant="secondary"
            size="$md"
            onPress={handleReport}
          >
            Report Issue
          </Button>
        ) : null}
      </YStack>
    </YStack>
  )
}
