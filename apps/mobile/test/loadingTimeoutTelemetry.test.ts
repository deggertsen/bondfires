import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLoadingTimeoutTelemetry } from '../../../packages/app/src/hooks/useLoadingTimeoutTelemetry'

const telemetry = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  breadcrumb: vi.fn(),
}))

vi.mock('../../../packages/app/src/services/telemetry', () => ({ telemetry }))
vi.mock('../../../packages/app/src/store', () => ({
  livePublishStore$: { status: { peek: () => 'idle' } },
  recordingStore$: { phase: { peek: () => 'idle' } },
}))

type LoadingTimeoutResult = ReturnType<typeof useLoadingTimeoutTelemetry>

describe('useLoadingTimeoutTelemetry', () => {
  let latestResult: LoadingTimeoutResult | undefined
  let renderer: ReturnType<typeof create> | undefined

  function Harness() {
    latestResult = useLoadingTimeoutTelemetry({
      eventName: 'test-load',
      label: 'Test load',
      isLoading: true,
      slowLoadThresholdMs: 10,
      loadingTimeoutMs: 20,
    })
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    for (const logger of Object.values(telemetry)) logger.mockReset()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount())
    }
    renderer = undefined
    latestResult = undefined
    vi.useRealTimers()
  })

  it('re-arms the timeout after resetting load tracking', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => vi.advanceTimersByTime(20))

    expect(latestResult?.timedOut).toBe(true)
    expect(telemetry.error).toHaveBeenCalledOnce()

    await act(async () => latestResult?.resetLoadTracking())
    expect(latestResult?.timedOut).toBe(false)

    await act(async () => vi.advanceTimersByTime(20))
    expect(latestResult?.timedOut).toBe(true)
    expect(telemetry.error).toHaveBeenCalledTimes(2)
  })
})
