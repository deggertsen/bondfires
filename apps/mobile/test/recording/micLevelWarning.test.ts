import { describe, expect, it } from 'vitest'
import {
  createMicLevelWarning,
  type MicLevelStats,
} from '../../../../packages/app/src/utils/micLevelWarning'
import { LOUDNESS } from '../../../../packages/media/src/loudness'

// Mirrors the native derivation, not a hardcoded warning threshold.
const rescueFloor = 20 * Math.log10(LOUDNESS.captureRms / LOUDNESS.maxGain)
const threshold = rescueFloor - 2
function stats(now: number, level = threshold - 4): MicLevelStats {
  return {
    micLevelDb: level,
    micLowThresholdDb: threshold,
    micSampleCount: now * 48 + 1,
    appliedGainDb: 30,
    micMuted: false,
  }
}
function feed(
  detector: ReturnType<typeof createMicLevelWarning>,
  start: number,
  end: number,
  level?: number,
) {
  let visible = false
  for (let now = start; now <= end; now += 250)
    visible = detector.sample(stats(now, level), now, true)
  return visible
}

describe('pre-gain mic warning continuity', () => {
  it('requires ten seconds of frequent low samples and warns even at maximum applied gain', () => {
    const detector = createMicLevelWarning()
    expect(feed(detector, 0, 9750)).toBe(false)
    expect(detector.sample(stats(10_000), 10_000, true)).toBe(true)
  })
  it('does not infer continuity from a single sample or sparse five-second ticks', () => {
    const detector = createMicLevelWarning()
    for (const now of [0, 5000, 10_000, 15_000]) {
      expect(detector.sample(stats(now), now, true)).toBe(false)
    }
  })
  it('ignores brief dips, healthy input, and input that max gain can rescue', () => {
    for (const level of [-18, rescueFloor, threshold + 0.1]) {
      const detector = createMicLevelWarning()
      expect(feed(detector, 0, 2000)).toBe(false)
      expect(feed(detector, 2250, 20_000, level)).toBe(false)
    }
  })
  it('keeps breath/silence gaps and <500ms threshold excursions in the low window', () => {
    const detector = createMicLevelWarning()
    feed(detector, 0, 4000)
    feed(detector, 4250, 4750, -120)
    feed(detector, 5000, 5000, threshold + 1)
    expect(feed(detector, 5250, 10_000)).toBe(true)
  })
  it('re-arms when a low poll ends an excursion lasting 500ms', () => {
    const detector = createMicLevelWarning()
    expect(feed(detector, 0, 10_000)).toBe(true)
    expect(feed(detector, 10_250, 10_500, -18)).toBe(true)
    expect(feed(detector, 10_750, 20_500)).toBe(false)
    expect(feed(detector, 20_750, 20_750)).toBe(true)
  })
  it('clears after 500ms recovery and re-arms with a fresh ten-second window', () => {
    const detector = createMicLevelWarning()
    expect(feed(detector, 0, 10_000)).toBe(true)
    expect(feed(detector, 10_250, 10_500, -18)).toBe(true)
    expect(feed(detector, 10_750, 11_000, -18)).toBe(false)
    expect(feed(detector, 11_250, 21_000)).toBe(false)
    expect(feed(detector, 21_250, 21_250)).toBe(true)
  })
  it('resets for muted, stopped, unsupported, stale, or restarted capture', () => {
    const invalidSamples = [
      { ...stats(10_250), micMuted: true },
      {},
      { ...stats(10_250), micLevelDb: Number.NaN },
      { ...stats(10_250), micSampleCount: stats(10_000).micSampleCount },
      { ...stats(10_250), micSampleCount: 1 },
    ]
    for (const sample of invalidSamples) {
      const detector = createMicLevelWarning()
      expect(feed(detector, 0, 10_000)).toBe(true)
      expect(detector.sample(sample, 10_250, true)).toBe(false)
    }
    const detector = createMicLevelWarning()
    for (let now = 0; now <= 20_000; now += 250) {
      expect(detector.sample(stats(now), now, false)).toBe(false)
    }
    expect(feed(detector, 20_250, 30_000)).toBe(false)
  })
  it('drops continuity across long gaps and resets explicitly between recordings', () => {
    const detector = createMicLevelWarning()
    feed(detector, 0, 9750)
    expect(feed(detector, 11_000, 20_750)).toBe(false)
    expect(feed(detector, 21_000, 21_000)).toBe(true)
    expect(detector.reset()).toBe(false)
    expect(feed(detector, 21_250, 31_000)).toBe(false)
  })
})
