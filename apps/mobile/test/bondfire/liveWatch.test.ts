import { describe, expect, it } from 'vitest'
import {
  liveWatchLabel,
  PRESENCE_LABEL,
  playbackClock,
  presenceTop,
} from '../../app/(main)/bondfire/_lib/liveWatch'

describe('live watch presentation', () => {
  it('shows LIVE until stop, PROCESSING for the uploading tail, and no ready pill', () => {
    expect(liveWatchLabel(true)).toBe('LIVE')
    expect(liveWatchLabel(true, false)).toBe('LIVE')
    expect(liveWatchLabel(true, true)).toBe('PROCESSING')
    expect(liveWatchLabel(false, true)).toBeNull()
    expect(liveWatchLabel(false)).toBeNull()
  })
  it('places here below the header even with a small Android inset', () => {
    expect(PRESENCE_LABEL).toBe('here')
    expect(presenceTop(4)).toBe(4 + 10 + 40 + 12 + 8)
    expect(presenceTop(59)).toBe(59 + 10 + 40 + 12 + 8)
  })
  it.each([
    [15, 12, 12, 12],
    [62, 32, 32, 32],
    [336, 212, 212, 212],
    [0, Infinity, -1, 0],
  ])('never renders elapsed beyond total (%s/%s)', (time, duration, buffered, server) => {
    const clock = playbackClock(time, duration, buffered, server)
    expect(clock.elapsedMs).toBeLessThanOrEqual(clock.totalMs)
    expect(clock.progress).toBeLessThanOrEqual(1)
    expect(Number.isFinite(clock.totalMs)).toBe(true)
  })
  it('grows the total from server receipts ahead of a stationary playhead', () => {
    expect(playbackClock(12, 12, 13, 16)).toEqual({
      elapsedMs: 12000,
      totalMs: 16000,
      progress: 0.75,
    })
    expect(playbackClock(12, 12, 13, 20)).toEqual({
      elapsedMs: 12000,
      totalMs: 20000,
      progress: 0.6,
    })
    expect(playbackClock(12, 12, 24, 20).totalMs).toBe(24000)
  })
})
