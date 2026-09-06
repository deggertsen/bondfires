import { describe, expect, it } from 'vitest'
import { getHomeFeedEmptyState } from '../../lib/homeFeedState'

describe('Home empty-state pagination', () => {
  const defaults = { pageState: 'done' as const, loadedCount: 50, query: '', viewMode: 'discover' }
  it.each([0, 50])(
    'does not show caught-up or empty while more pages exist (%i loaded)',
    (loadedCount) => {
      expect(getHomeFeedEmptyState({ ...defaults, loadedCount, pageState: 'available' })).toBe(
        'more',
      )
      expect(getHomeFeedEmptyState({ ...defaults, loadedCount, pageState: 'loading' })).toBe(
        'loading',
      )
    },
  )
  it('offers Spark only after discovery is exhausted without a search', () => {
    expect(getHomeFeedEmptyState(defaults)).toBe('caught-up')
    expect(getHomeFeedEmptyState({ ...defaults, query: '  ' })).toBe('caught-up')
    expect(getHomeFeedEmptyState({ ...defaults, loadedCount: 0 })).toBe('empty')
  })
  it.each(['recent', 'active', 'unseen'])('keeps Reset for the %s filter', (viewMode) => {
    expect(getHomeFeedEmptyState({ ...defaults, viewMode })).toBe('no-matches')
  })
  it('keeps Reset for real search mismatches', () => {
    expect(getHomeFeedEmptyState({ ...defaults, query: 'missing' })).toBe('no-matches')
  })
})
