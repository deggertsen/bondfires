import { describe, expect, it } from 'vitest'
import { isWatchedFromEvents } from './viewerWatchState'

const DURATION = 30_000

describe('isWatchedFromEvents', () => {
  it('is unwatched with no events', () => {
    expect(isWatchedFromEvents([], DURATION)).toBe(false)
    expect(isWatchedFromEvents([], undefined)).toBe(false)
  })

  it('needs a complete event for newly recorded views', () => {
    const started = [
      { eventType: 'start', completionRequired: true },
      { eventType: 'milestone_75', completionRequired: true },
    ]
    expect(isWatchedFromEvents(started, DURATION)).toBe(false)
    expect(
      isWatchedFromEvents(
        [...started, { eventType: 'complete', completionRequired: true }],
        DURATION,
      ),
    ).toBe(true)
  })

  it('preserves legacy views even when new events are added', () => {
    const legacy = { eventType: 'start' }
    expect(isWatchedFromEvents([legacy], DURATION)).toBe(true)
    expect(
      isWatchedFromEvents(
        [legacy, { eventType: 'milestone_25', completionRequired: true }],
        DURATION,
      ),
    ).toBe(true)
  })

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'counts a new event when duration %s cannot support completion',
    (duration) => {
      expect(
        isWatchedFromEvents([{ eventType: 'start', completionRequired: true }], duration),
      ).toBe(true)
    },
  )
})
