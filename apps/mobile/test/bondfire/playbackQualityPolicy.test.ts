import { describe, expect, it } from 'vitest'
import {
  createPlaybackQualityPolicy,
  playbackSize,
} from '../../../../packages/app/src/utils/playbackQualityPolicy'

describe('playback battery policy', () => {
  it('respects the selected ceiling until sustained warmth, then waits a cool minute', () => {
    const policy = createPlaybackQualityPolicy()
    policy.thermal(1, 0)
    policy.thermal(1, 19_999)
    expect(policy.resolution(1080)).toBe(1080)
    policy.thermal(1, 20_000)
    expect(policy.resolution(1080)).toBe(480)
    policy.thermal(0, 30_000)
    for (let time = 40_000; time <= 80_000; time += 10_000) policy.thermal(0, time)
    policy.thermal(0, 89_999)
    expect(policy.resolution(720)).toBe(480)
    policy.thermal(0, 90_000)
    expect(policy.resolution(720)).toBe(720)
  })
  it('reacts immediately to serious heat and ignores unsupported readings', () => {
    const policy = createPlaybackQualityPolicy()
    policy.thermal(2, 0)
    policy.thermal(-1, 100_000)
    expect(policy.resolution(1080)).toBe(480)
  })
  it('requires two recent stalls and uninterrupted stable playback to recover', () => {
    const policy = createPlaybackQualityPolicy()
    policy.stall(0)
    policy.stall(31_000)
    expect(policy.resolution(720)).toBe(720)
    policy.stall(40_000)
    expect(policy.resolution(720)).toBe(480)
    policy.playback(true, 41_000)
    policy.playback(false, 90_000)
    policy.playback(true, 100_000)
    policy.playback(true, 159_999)
    expect(policy.resolution(720)).toBe(480)
    policy.playback(true, 160_000)
    expect(policy.resolution(720)).toBe(720)
  })
  it('network recovery does not override the thermal ceiling', () => {
    const policy = createPlaybackQualityPolicy()
    policy.thermal(2, 0)
    policy.stall(0)
    policy.stall(10_000)
    policy.playback(true, 20_000)
    policy.playback(true, 80_000)
    expect(policy.resolution(1080)).toBe(480)
  })
  it('preserves portrait, landscape, and square aspect ratios', () => {
    expect(playbackSize(720)).toEqual({ width: 720, height: 1280 })
    expect(playbackSize(480, { width: 1920, height: 1080 })).toEqual({ width: 854, height: 480 })
    expect(playbackSize(720, { width: 1000, height: 1000 })).toEqual({ width: 720, height: 720 })
  })
})
