import { describe, expect, it } from 'vitest'
import { isWatchedFromEvents, WATCH_COMPLETION_REQUIRED_SINCE } from './viewerWatchState'

const AFTER = WATCH_COMPLETION_REQUIRED_SINCE + 60_000
const BEFORE = WATCH_COMPLETION_REQUIRED_SINCE - 60_000
const DURATION = 30_000

describe('isWatchedFromEvents', () => {
  it('is unwatched with no events', () => {
    expect(isWatchedFromEvents([], DURATION)).toBe(false)
    expect(isWatchedFromEvents([], undefined)).toBe(false)
  })

  it('needs a complete event once completion is required', () => {
    const started = [
      { eventType: 'start', createdAt: AFTER },
      { eventType: 'milestone_75', createdAt: AFTER },
    ]
    expect(isWatchedFromEvents(started, DURATION)).toBe(false)
    expect(
      isWatchedFromEvents([...started, { eventType: 'complete', createdAt: AFTER }], DURATION),
    ).toBe(true)
  })

  it('keeps counting any event recorded before completion was required', () => {
    expect(isWatchedFromEvents([{ eventType: 'start', createdAt: BEFORE }], DURATION)).toBe(true)
  })

  it('counts any event for a video that cannot record complete', () => {
    const started = [{ eventType: 'start', createdAt: AFTER }]
    expect(isWatchedFromEvents(started, undefined)).toBe(true)
    expect(isWatchedFromEvents(started, 0)).toBe(true)
  })
})
