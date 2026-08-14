import type { useConvex } from 'convex/react'
import { telemetry } from '../services/telemetry'

type ReconnectableWebSocketManager = {
  socketState?: () => unknown
  tryReconnectImmediately?: () => void
  closeAndReconnect?: (reason: string) => void
}

type ConvexInternalSync = {
  sync?: { webSocketManager?: ReconnectableWebSocketManager }
  cachedSync?: { webSocketManager?: ReconnectableWebSocketManager }
}

/**
 * Force the Convex WebSocket to reconnect. The two internal WebSocketManager
 * methods are complementary and each no-ops outside its own socket state:
 * - "disconnected" (waiting on a backoff timer): tryReconnectImmediately()
 *   cancels the timer and dials now — closeAndReconnect() would no-op here
 * - "connecting" (DNS/TCP hanging) or "ready": closeAndReconnect() tears the
 *   socket down and reconnects — tryReconnectImmediately() would no-op here
 *
 * The TS types mark webSocketManager as private, but it's accessible at
 * runtime. This is a known workaround pattern for Convex RN apps.
 */
export function forceConvexReconnect(convex: ReturnType<typeof useConvex>): boolean {
  try {
    const internalConvex = convex as unknown as ConvexInternalSync
    const sync = internalConvex.sync ?? internalConvex.cachedSync
    const wsm = sync?.webSocketManager
    if (!wsm) {
      telemetry.warn('loading:reconnect', 'Convex webSocketManager not found', {
        hasSync: !!sync,
      })
      return false
    }

    const socketState = typeof wsm.socketState === 'function' ? wsm.socketState() : undefined
    if (socketState === 'disconnected' && typeof wsm.tryReconnectImmediately === 'function') {
      wsm.tryReconnectImmediately()
      return true
    }
    if (typeof wsm.closeAndReconnect === 'function') {
      wsm.closeAndReconnect('client')
      return true
    }
    telemetry.warn('loading:reconnect', 'Convex reconnect methods not found', { socketState })
    return false
  } catch (error) {
    telemetry.warn('loading:reconnect', `Failed to force reconnect: ${String(error)}`)
    return false
  }
}
