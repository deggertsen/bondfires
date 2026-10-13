import { describe, expect, it } from 'vitest'
import { getHomeFeedEmptyState, isHomeFeedLoading } from '../../lib/homeFeedState'

describe('Home first-paint gate', () => {
  it('holds the loading state until the feed resolves', () => {
    expect(
      isHomeFeedLoading({ feedResolved: false, railQueryEnabled: true, railResolved: false }),
    ).toBe(true)
    expect(
      isHomeFeedLoading({ feedResolved: false, railQueryEnabled: true, railResolved: true }),
    ).toBe(true)
  })

  it('waits for the thread query when it is enabled', () => {
    expect(
      isHomeFeedLoading({ feedResolved: true, railQueryEnabled: true, railResolved: false }),
    ).toBe(true)
  })

  it('paints once both the feed and the thread query have resolved', () => {
    expect(
      isHomeFeedLoading({ feedResolved: true, railQueryEnabled: true, railResolved: true }),
    ).toBe(false)
  })

  it('never gates on a skipped thread query', () => {
    // Blurred tab or unresolved auth: listMyFires is 'skip' and never resolves.
    expect(
      isHomeFeedLoading({ feedResolved: true, railQueryEnabled: false, railResolved: false }),
    ).toBe(false)
  })
})

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
