import { describe, expect, it } from 'vitest'
import {
  createStallDetector,
  IOS_STALL_BITRATE_FLOOR_BPS,
  NEVER_STARTED_SAMPLE_LIMIT,
  STALL_BITRATE_FLOOR_BPS,
  STALL_SAMPLE_LIMIT,
} from '../../../../packages/app/src/utils/liveStallDetector'

const HEALTHY = { bitrateBps: 2_500_000, statsSupported: true }
const ZERO = { bitrateBps: 0, statsSupported: true }
const AMBIENT = { bitrateBps: STALL_BITRATE_FLOOR_BPS - 1, statsSupported: true }
const UNMEASURED = { bitrateBps: 0, statsSupported: false }

describe('liveStallDetector', () => {
  it('never fires on unmeasurable samples (old native builds)', () => {
    const detector = createStallDetector()
    for (let i = 0; i < 100; i++) {
      const verdict = detector.sample(UNMEASURED)
      expect(verdict.stalled).toBe(false)
      expect(verdict.measured).toBe(false)
      expect(verdict.sawThroughput).toBe(false)
    }
  })

  it('detects a pipeline that never produces a frame', () => {
    const detector = createStallDetector()
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    const verdict = detector.sample(ZERO)
    expect(verdict).toEqual({
      stalled: true,
      measured: true,
      sawThroughput: false,
      neverStarted: true,
      samples: NEVER_STARTED_SAMPLE_LIMIT,
    })
  })

  it('treats ambient sub-floor traffic (websocket, telemetry) as zero', () => {
    const detector = createStallDetector()
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(AMBIENT).stalled).toBe(false)
    }
    expect(detector.sample(AMBIENT).stalled).toBe(true)
  })

  it('detects an encoder stall after healthy throughput, at the shorter limit', () => {
    const detector = createStallDetector()
    expect(detector.sample(HEALTHY).sawThroughput).toBe(true)
    for (let i = 0; i < STALL_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    const verdict = detector.sample(ZERO)
    expect(verdict).toEqual({
      stalled: true,
      measured: true,
      sawThroughput: true,
      neverStarted: false,
      samples: STALL_SAMPLE_LIMIT,
    })
  })

  it('resets the zero streak on recovered throughput', () => {
    const detector = createStallDetector()
    detector.sample(HEALTHY)
    detector.sample(ZERO)
    detector.sample(ZERO)
    detector.sample(HEALTHY)
    for (let i = 0; i < STALL_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })

  it('resets the zero streak while not live (idle ticks)', () => {
    const detector = createStallDetector()
    detector.sample(ZERO)
    detector.sample(ZERO)
    detector.sample(ZERO)
    detector.idle()
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })

  it('unmeasurable samples do not extend or reset the streak', () => {
    const detector = createStallDetector()
    detector.sample(ZERO)
    detector.sample(UNMEASURED)
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 2; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })

  it('full reset clears throughput history', () => {
    const detector = createStallDetector()
    detector.sample(HEALTHY)
    detector.reset()
    expect(detector.sample(ZERO).sawThroughput).toBe(false)
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 2; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })

  it('iOS exact-zero floor treats a genuinely low-bitrate stream as healthy', () => {
    // A muted, static-scene iOS stream can legitimately encode below the
    // Android floor; per-stream measurement must never call that a stall.
    const detector = createStallDetector(IOS_STALL_BITRATE_FLOOR_BPS)
    const LOW_BUT_REAL = { bitrateBps: 20_000, statsSupported: true }
    for (let i = 0; i < 50; i++) {
      const verdict = detector.sample(LOW_BUT_REAL)
      expect(verdict.stalled).toBe(false)
      expect(verdict.sawThroughput).toBe(true)
    }
    // Exact zero still stalls after the post-throughput limit.
    for (let i = 0; i < STALL_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })
})
