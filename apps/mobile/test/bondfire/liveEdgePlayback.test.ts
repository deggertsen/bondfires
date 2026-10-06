import { describe, expect, it } from 'vitest'
import {
  decideLiveEdgeStall,
  LIVE_EDGE_BUFFER_HOLD_MS,
  LIVE_EDGE_FALLBACK_RATE,
  resolveEffectivePlaybackRate,
} from '../../app/(main)/bondfire/_lib/liveEdgePlayback'

describe('live-edge stall policy', () => {
  it('leaves VOD stalls to reload-based recovery', () => {
    expect(decideLiveEdgeStall(false, 2)).toBe('none')
    expect(decideLiveEdgeStall(false, 1)).toBe('none')
  })

  it('drops a faster-than-realtime live stream to realtime at the edge', () => {
    expect(decideLiveEdgeStall(true, 2)).toBe('switch-to-realtime')
    expect(decideLiveEdgeStall(true, 1.5)).toBe('switch-to-realtime')
  })

  it('extends the buffer once a live stream is already realtime', () => {
    expect(decideLiveEdgeStall(true, 1)).toBe('extend-buffer')
    expect(decideLiveEdgeStall(true, 0.5)).toBe('extend-buffer')
  })
})

describe('effective playback rate', () => {
  it('prefers the user speed for VOD', () => {
    expect(resolveEffectivePlaybackRate(false, true, 2)).toBe(2)
    expect(resolveEffectivePlaybackRate(false, false, 1.5)).toBe(1.5)
  })

  it('holds a live stream at realtime after an edge fallback', () => {
    expect(resolveEffectivePlaybackRate(true, true, 2)).toBe(LIVE_EDGE_FALLBACK_RATE)
  })

  it('respects the user speed for live until a fallback happens', () => {
    expect(resolveEffectivePlaybackRate(true, false, 2)).toBe(2)
  })

  it('holds the buffer for a few seconds on top of the natural stall', () => {
    expect(LIVE_EDGE_BUFFER_HOLD_MS).toBeGreaterThanOrEqual(5_000)
  })
})
