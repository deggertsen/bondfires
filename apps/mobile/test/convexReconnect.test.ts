import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forceConvexReconnect } from '../../../packages/app/src/utils/convexReconnect'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../../packages/app/src/services/telemetry', () => ({
  telemetry: { warn },
}))

type ConvexClient = Parameters<typeof forceConvexReconnect>[0]

function asConvexClient(value: unknown): ConvexClient {
  return value as ConvexClient
}

describe('forceConvexReconnect', () => {
  beforeEach(() => {
    warn.mockReset()
  })

  it('reconnects immediately from a disconnected backoff state', () => {
    const tryReconnectImmediately = vi.fn()
    const closeAndReconnect = vi.fn()
    const convex = asConvexClient({
      sync: {
        webSocketManager: {
          socketState: () => 'disconnected',
          tryReconnectImmediately,
          closeAndReconnect,
        },
      },
    })

    expect(forceConvexReconnect(convex)).toBe(true)
    expect(tryReconnectImmediately).toHaveBeenCalledOnce()
    expect(closeAndReconnect).not.toHaveBeenCalled()
  })

  it('closes and reconnects a connecting or ready socket', () => {
    const closeAndReconnect = vi.fn()
    const convex = asConvexClient({
      cachedSync: {
        webSocketManager: {
          socketState: () => 'connecting',
          closeAndReconnect,
        },
      },
    })

    expect(forceConvexReconnect(convex)).toBe(true)
    expect(closeAndReconnect).toHaveBeenCalledWith('client')
  })

  it('reports unavailable Convex internals without throwing', () => {
    expect(forceConvexReconnect(asConvexClient({}))).toBe(false)
    expect(warn).toHaveBeenCalledWith('loading:reconnect', 'Convex webSocketManager not found', {
      hasSync: false,
    })
  })

  it('reports reconnect failures without throwing', () => {
    const convex = asConvexClient({
      sync: {
        webSocketManager: {
          socketState: () => {
            throw new Error('socket state unavailable')
          },
        },
      },
    })

    expect(forceConvexReconnect(convex)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      'loading:reconnect',
      'Failed to force reconnect: Error: socket state unavailable',
    )
  })
})
