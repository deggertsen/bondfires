import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMicLevelWarning } from '../../../../packages/app/src/hooks/useMicLevelWarning'
import type { MicLevelStats } from '../../../../packages/app/src/utils/micLevelWarning'

const events = vi.hoisted(() => ({ info: vi.fn(), breadcrumb: vi.fn() }))
vi.mock('../../../../packages/app/src/services/telemetry', () => ({ telemetry: events }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('polls only active recording, suppresses mute, emits once per warning, and ignores late replies', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let muted = false
  let level = -54
  let visible = false
  let delayed: ((stats: MicLevelStats) => void) | undefined
  let delay = false
  const publisher = {
    getStats: vi.fn(async (): Promise<MicLevelStats> => {
      if (delay)
        return new Promise((resolve) => {
          delayed = resolve
        })
      return {
        micLevelDb: level,
        appliedGainDb: 30,
        micLowThresholdDb: -50,
        micSampleCount: performance.now() * 48 + 1,
        micMuted: muted,
      }
    }),
  }
  function Harness({ recording }: { recording: boolean }) {
    visible = useMicLevelWarning({ publisher, recording, recordingId: 'test-recording' })
    return null
  }
  let renderer: ReturnType<typeof create>
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  try {
    await act(async () => {
      renderer = create(createElement(Harness, { recording: false }))
    })
    await advance(15_000)
    expect(publisher.getStats).not.toHaveBeenCalled()
    await act(async () => {
      renderer.update(createElement(Harness, { recording: true }))
    })
    await advance(9750)
    expect(visible).toBe(false)
    await advance(250)
    expect(visible).toBe(true)
    await advance(2000)
    expect(events.info).toHaveBeenCalledTimes(1)
    expect(events.info.mock.calls[0]?.[0]).toBe('live:audio_level_warning')
    level = -18
    await advance(750)
    expect(visible).toBe(false)
    muted = true
    level = -54
    await advance(12_000)
    expect(visible).toBe(false)
    muted = false
    await advance(10_250)
    expect(visible).toBe(true)
    expect(events.info).toHaveBeenCalledTimes(2)
    delay = true
    await advance(250)
    await act(async () => {
      renderer.update(createElement(Harness, { recording: false }))
    })
    expect(visible).toBe(false)
    const calls = publisher.getStats.mock.calls.length
    await act(async () => {
      delayed?.({ micLevelDb: -54, micLowThresholdDb: -50, micSampleCount: 9e6, micMuted: false })
    })
    await advance(15_000)
    expect(publisher.getStats).toHaveBeenCalledTimes(calls)
    expect(events.info).toHaveBeenCalledTimes(2)
    expect(visible).toBe(false)
  } finally {
    await act(async () => renderer?.unmount())
  }
})

// Keep a native request pending while the JS interval continues running.
// Expiry must not depend on that request ever resolving or rejecting.
it('expires a visible warning during a hung poll and discards the delayed reply', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let visible = false
  let resolvePending: ((stats: MicLevelStats) => void) | undefined
  let delayed = false
  const lowStats = (): MicLevelStats => ({
    micLevelDb: -54,
    micLowThresholdDb: -50,
    micSampleCount: performance.now() * 48 + 1,
    micMuted: false,
  })
  const publisher = {
    getStats: vi.fn(async () => {
      if (delayed)
        return new Promise<MicLevelStats>((resolve) => {
          resolvePending = resolve
        })
      return lowStats()
    }),
  }
  function Harness() {
    visible = useMicLevelWarning({ publisher, recording: true, recordingId: 'test-recording' })
    return null
  }
  let renderer: ReturnType<typeof create>
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await advance(10_000)
    expect(visible).toBe(true)
    delayed = true
    await advance(250)
    const calls = publisher.getStats.mock.calls.length
    await advance(750)
    expect(visible).toBe(false)
    await advance(5000)
    expect(publisher.getStats).toHaveBeenCalledTimes(calls)
    delayed = false
    await act(async () => {
      resolvePending?.(lowStats())
    })
    expect(visible).toBe(false)
    // The delayed reply cannot seed the new window, even with fresh-looking PCM.
    await advance(10_000)
    expect(visible).toBe(false)
    await advance(250)
    expect(visible).toBe(true)
    expect(events.info).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => renderer?.unmount())
  }
})

it('does not count native reply latency toward ten seconds of quiet input', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let visible = false
  let resolvePending: (() => void) | undefined
  const publisher = {
    getStats: vi.fn(async () => {
      const now = performance.now()
      const stats: MicLevelStats = {
        micLevelDb: -54,
        micLowThresholdDb: -50,
        micSampleCount: now * 48 + 1,
        micMuted: false,
      }
      if (now === 9750) {
        return new Promise<MicLevelStats>((resolve) => {
          resolvePending = () => resolve(stats)
        })
      }
      return stats
    }),
  }
  function Harness() {
    visible = useMicLevelWarning({ publisher, recording: true, recordingId: 'test-recording' })
    return null
  }
  let renderer: ReturnType<typeof create>
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await advance(10_250)
    await act(async () => {
      resolvePending?.()
    })
    expect(visible).toBe(false)
    expect(events.info).not.toHaveBeenCalled()
    await advance(250)
    expect(visible).toBe(true)
    expect(events.info).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => renderer?.unmount())
  }
})
