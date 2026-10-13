import type { ConnectionState } from 'convex/browser'
import type { TelemetryLogger } from '../../../packages/app/src/services/telemetry'

export function createConnectionStateLogger(
  telemetry: Pick<TelemetryLogger, 'breadcrumb' | 'warn'>,
) {
  let reported: 'breadcrumb' | 'warn' | null = null

  return (state: ConnectionState) => {
    if (state.isWebSocketConnected) {
      reported = null
      return
    }

    // Convex also publishes request-count and retry-count changes. Report each
    // disconnect once, with at most one escalation if requests become pending.
    if (reported === 'warn') return
    if (state.hasInflightRequests) {
      reported = 'warn'
      telemetry.warn('convex:connection', 'WebSocket disconnected with in-flight requests', {
        hasInflightRequests: true,
      })
    } else if (reported === null) {
      reported = 'breadcrumb'
      telemetry.breadcrumb('convex:connection', { hasInflightRequests: false })
    }
  }
}
