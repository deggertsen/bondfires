import { describe, expect, it } from 'vitest'
import {
  createStallDetector,
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
      expect(detector.sample(UNMEASURED).stalled).toBe(false)
    }
    expect(detector.sawThroughput).toBe(false)
  })

  it('detects a pipeline that never produces a frame', () => {
    const detector = createStallDetector()
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    const verdict = detector.sample(ZERO)
    expect(verdict).toEqual({
      stalled: true,
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
    detector.sample(HEALTHY)
    expect(detector.sawThroughput).toBe(true)
    for (let i = 0; i < STALL_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    const verdict = detector.sample(ZERO)
    expect(verdict).toEqual({
      stalled: true,
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
    expect(detector.sawThroughput).toBe(false)
    for (let i = 0; i < NEVER_STARTED_SAMPLE_LIMIT - 1; i++) {
      expect(detector.sample(ZERO).stalled).toBe(false)
    }
    expect(detector.sample(ZERO).stalled).toBe(true)
  })
})
