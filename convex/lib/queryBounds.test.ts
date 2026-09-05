import { describe, expect, it } from 'vitest'
import { boundedInteger, boundedScanSize } from './queryBounds'

describe('query bounds', () => {
  it('uses defaults and caps oversized caller input', () => {
    const bound = { defaultValue: 20, min: 1, max: 50, name: 'limit' }
    expect(boundedInteger(undefined, bound)).toBe(20)
    expect(boundedInteger(25, bound)).toBe(25)
    expect(boundedInteger(50_000, bound)).toBe(50)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed numeric input: %s',
    (value) => {
      expect(() =>
        boundedInteger(value, { defaultValue: 20, min: 1, max: 50, name: 'limit' }),
      ).toThrow('limit must be an integer of at least 1')
    },
  )

  it('bounds visibility overfetch independently of the requested size', () => {
    expect(boundedScanSize(20, 3, 150)).toBe(60)
    expect(boundedScanSize(100, 3, 150)).toBe(150)
  })
})
