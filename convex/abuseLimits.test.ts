import { describe, expect, it } from 'vitest'
import { getFixedWindowUpdate } from './abuseLimits'

describe('transactional fixed-window decisions', () => {
  it('allows exactly the configured number of events', () => {
    let state: { count: number; windowStartedAt: number } | null = null
    for (let count = 1; count <= 3; count += 1) {
      const result = getFixedWindowUpdate(state, { now: 1_000 + count, limit: 3, windowMs: 100 })
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(count)
      state = result
    }
    expect(getFixedWindowUpdate(state, { now: 1_050, limit: 3, windowMs: 100 })).toMatchObject({
      allowed: false,
      count: 3,
      retryAfterMs: 51,
    })
  })

  it('starts a fresh window at the boundary', () => {
    expect(
      getFixedWindowUpdate(
        { count: 20, windowStartedAt: 1_000 },
        { now: 1_100, limit: 20, windowMs: 100 },
      ),
    ).toEqual({ allowed: true, count: 1, windowStartedAt: 1_100, retryAfterMs: 0 })
  })

  it('rejects unsafe limiter configuration', () => {
    expect(() => getFixedWindowUpdate(null, { now: 0, limit: 0, windowMs: 100 })).toThrow()
  })
})
