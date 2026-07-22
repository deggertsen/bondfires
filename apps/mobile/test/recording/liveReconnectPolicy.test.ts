import { describe, expect, it } from 'vitest'
import {
  computeReconnectDeadlineMs,
  getReconnectAttemptDelayMs,
  RECONNECT_SAFETY_MARGIN_MS,
  shouldAttemptLiveReconnect,
} from '../../../../packages/app/src/utils/liveReconnectPolicy'

const reconnectable = {
  liveStatus: 'endpoint_closed',
  phase: 'recording',
  reconnectWindowSeconds: 60,
  everHadThroughput: true,
} as const

describe('shouldAttemptLiveReconnect', () => {
  it('reconnects a socket drop mid-recording when the window is open', () => {
    expect(shouldAttemptLiveReconnect(reconnectable)).toBe(true)
  })

  it('treats an unmeasured throughput history as reconnectable', () => {
    // null = no measurable sample yet (platform without stats); only a
    // confirmed never-started (false) session skips straight to cancel.
    expect(shouldAttemptLiveReconnect({ ...reconnectable, everHadThroughput: null })).toBe(true)
  })

  it('never reconnects a session that provably sent nothing', () => {
    expect(shouldAttemptLiveReconnect({ ...reconnectable, everHadThroughput: false })).toBe(false)
  })

  it('never reconnects when the server has the window disabled', () => {
    expect(shouldAttemptLiveReconnect({ ...reconnectable, reconnectWindowSeconds: 0 })).toBe(false)
  })

  it('only reconnects socket-level drops, not encoder stalls or errors', () => {
    expect(
      shouldAttemptLiveReconnect({ ...reconnectable, liveStatus: 'stream_stopped_unexpectedly' }),
    ).toBe(false)
    expect(shouldAttemptLiveReconnect({ ...reconnectable, liveStatus: 'errored' })).toBe(false)
  })

  it('only reconnects while the recording flow is active', () => {
    expect(shouldAttemptLiveReconnect({ ...reconnectable, phase: 'stopping' })).toBe(false)
    expect(shouldAttemptLiveReconnect({ ...reconnectable, phase: 'idle' })).toBe(false)
  })
})

describe('computeReconnectDeadlineMs', () => {
  it('budgets the window minus the safety margin', () => {
    expect(computeReconnectDeadlineMs(60, 1_000_000)).toBe(
      1_000_000 + 60_000 - RECONNECT_SAFETY_MARGIN_MS,
    )
  })

  it('never returns a deadline in the past for tiny windows', () => {
    expect(computeReconnectDeadlineMs(5, 1_000_000)).toBe(1_000_000)
    expect(computeReconnectDeadlineMs(0, 1_000_000)).toBe(1_000_000)
  })
})

describe('getReconnectAttemptDelayMs', () => {
  it('retries fast first, then backs off to a ceiling', () => {
    expect(getReconnectAttemptDelayMs(0)).toBe(1_000)
    expect(getReconnectAttemptDelayMs(1)).toBe(3_000)
    expect(getReconnectAttemptDelayMs(2)).toBe(5_000)
    expect(getReconnectAttemptDelayMs(3)).toBe(8_000)
    expect(getReconnectAttemptDelayMs(10)).toBe(8_000)
  })

  it('total ladder time stays well inside a 60s window budget', () => {
    // 6 attempts: 1+3+5+8+8+8 = 33s < 50s budget (60s window - 10s margin),
    // leaving room for the attempts themselves to take time.
    const total = Array.from({ length: 6 }, (_, i) => getReconnectAttemptDelayMs(i)).reduce(
      (a, b) => a + b,
      0,
    )
    expect(total).toBeLessThan(60_000 - RECONNECT_SAFETY_MARGIN_MS)
  })
})
