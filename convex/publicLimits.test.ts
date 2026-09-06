import { describe, expect, it } from 'vitest'
import { normalizeCleanupLimit, normalizeFeedLimit } from './bondfires'
import { assertClientMediaMetadataBounds } from './videos'
import { normalizeWatchHistoryLimit } from './watchEvents'

describe('public numeric input caps', () => {
  it('clamps feed limits to a finite positive boundary', () => {
    expect(normalizeFeedLimit(undefined)).toBe(20)
    expect(normalizeFeedLimit(-1_000)).toBe(1)
    expect(normalizeFeedLimit(12.9)).toBe(12)
    expect(normalizeFeedLimit(1_000_000)).toBe(50)
    expect(normalizeFeedLimit(Number.NaN)).toBe(20)
    expect(normalizeFeedLimit(Number.POSITIVE_INFINITY)).toBe(20)
  })

  it('clamps maintenance and watch-history limits including non-finite values', () => {
    expect(normalizeCleanupLimit(Number.NaN)).toBe(100)
    expect(normalizeCleanupLimit(10_000)).toBe(100)
    expect(normalizeWatchHistoryLimit(Number.NaN)).toBe(50)
    expect(normalizeWatchHistoryLimit(-5)).toBe(1)
    expect(normalizeWatchHistoryLimit(10_000)).toBe(100)
  })

  it('rejects malformed or oversized client media metadata', () => {
    expect(() => assertClientMediaMetadataBounds({ width: Number.NaN })).toThrow()
    expect(() => assertClientMediaMetadataBounds({ height: 0 })).toThrow()
    expect(() => assertClientMediaMetadataBounds({ width: 16_385 })).toThrow()
    expect(() => assertClientMediaMetadataBounds({ tags: Array(21).fill('tag') })).toThrow()
    expect(() => assertClientMediaMetadataBounds({ width: 1_920, height: 1_080 })).not.toThrow()
  })
})
