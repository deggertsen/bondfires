import type { ConnectionState } from 'convex/browser'
import { describe, expect, it, vi } from 'vitest'
import { createConnectionStateLogger } from '../lib/convexConnectionTelemetry'

const connected: ConnectionState = {
  isWebSocketConnected: true,
  hasInflightRequests: false,
  hasEverConnected: true,
  connectionCount: 1,
  connectionRetries: 0,
  timeOfOldestInflightRequest: null,
  inflightMutations: 0,
  inflightActions: 0,
}
const idle = { ...connected, isWebSocketConnected: false }
const pending = {
  ...idle,
  hasInflightRequests: true,
  inflightMutations: 1,
  timeOfOldestInflightRequest: new Date(0),
}

function setup() {
  const telemetry = { breadcrumb: vi.fn(), warn: vi.fn() }
  return { telemetry, onState: createConnectionStateLogger(telemetry) }
}

describe('Convex connection telemetry', () => {
  it('does not log connected request activity', () => {
    const { telemetry, onState } = setup()
    onState(connected)
    onState({ ...pending, isWebSocketConnected: true })
    expect(telemetry.breadcrumb).not.toHaveBeenCalled()
    expect(telemetry.warn).not.toHaveBeenCalled()
  })

  it('records one breadcrumb for an idle disconnect despite reconnect attempts', () => {
    const { telemetry, onState } = setup()
    onState(connected)
    onState(idle)
    onState({ ...idle, connectionRetries: 1 })
    onState({ ...idle, connectionRetries: 2 })
    expect(telemetry.breadcrumb).toHaveBeenCalledExactlyOnceWith('convex:connection', {
      hasInflightRequests: false,
    })
    expect(telemetry.warn).not.toHaveBeenCalled()
  })

  it('warns once for pending requests despite retries and request activity', () => {
    const { telemetry, onState } = setup()
    onState(connected)
    onState(pending)
    onState({ ...pending, connectionRetries: 1 })
    onState({ ...pending, inflightMutations: 2 })
    onState(idle)
    onState(pending)
    expect(telemetry.warn).toHaveBeenCalledExactlyOnceWith(
      'convex:connection',
      'WebSocket disconnected with in-flight requests',
      { hasInflightRequests: true },
    )
    expect(telemetry.breadcrumb).not.toHaveBeenCalled()
  })

  it('escalates an idle disconnect once when requests become pending', () => {
    const { telemetry, onState } = setup()
    onState(idle)
    onState(pending)
    onState({ ...pending, inflightActions: 1 })
    expect(telemetry.breadcrumb).toHaveBeenCalledOnce()
    expect(telemetry.warn).toHaveBeenCalledOnce()
  })

  it('reports new disconnects after reconnection', () => {
    const { telemetry, onState } = setup()
    onState(idle)
    onState(pending)
    onState({ ...connected, connectionCount: 2 })
    onState({ ...idle, connectionCount: 2 })
    onState({ ...pending, connectionCount: 2 })
    expect(telemetry.breadcrumb).toHaveBeenCalledTimes(2)
    expect(telemetry.warn).toHaveBeenCalledTimes(2)
  })
})
