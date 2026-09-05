import { describe, expect, it } from 'vitest'
import { shouldLoadSparsePage, uniqueById } from '../lib/pagination'

describe('sparse visibility pagination', () => {
  it('continues past hidden pages after previously visible results', () => {
    const existingCount = 40
    const requestedCount = existingCount + 1
    expect(shouldLoadSparsePage('CanLoadMore', existingCount, requestedCount)).toBe(true)
    expect(shouldLoadSparsePage('LoadingMore', existingCount, requestedCount)).toBe(false)
    expect(shouldLoadSparsePage('CanLoadMore', existingCount + 1, requestedCount)).toBe(false)
    expect(shouldLoadSparsePage('Exhausted', existingCount, requestedCount)).toBe(false)
  })
  it('advances across more than a page of hidden rows until a visible camp is found', () => {
    // Each empty result represents a full raw page whose rows were hidden by
    // server-side eligibility filtering. This covers > page-size hidden rows.
    const visiblePages = [[], [], [{ _id: 'visible-camp' }]]
    let loaded: { _id: string }[] = []
    let requestedPages = 0

    for (const page of visiblePages) {
      requestedPages++
      loaded = loaded.concat(page)
      if (!shouldLoadSparsePage('CanLoadMore', loaded.length, 40)) break
    }

    expect(requestedPages).toBe(3)
    expect(loaded.map((camp) => camp._id)).toEqual(['visible-camp'])
    expect(shouldLoadSparsePage('Exhausted', loaded.length, 40)).toBe(false)
  })
})

describe('reactive page deduplication', () => {
  it('keeps first-seen cursor order while removing duplicates', () => {
    expect(
      uniqueById([
        { _id: 'a', page: 1 },
        { _id: 'b', page: 1 },
        { _id: 'b', page: 2 },
        { _id: 'c', page: 2 },
      ]),
    ).toEqual([
      { _id: 'a', page: 1 },
      { _id: 'b', page: 1 },
      { _id: 'c', page: 2 },
    ])
  })
})
