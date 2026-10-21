import { describe, expect, it } from 'vitest'
import {
  applyReactionCountDelta,
  rankRecentEmojis,
  sumReactionCounts,
  tallyReactionCounts,
} from './videoReactions'

describe('rankRecentEmojis', () => {
  it('ranks emojis by frequency with recency as the tiebreaker', () => {
    expect(
      rankRecentEmojis([
        { emoji: 'a', createdAt: 100 },
        { emoji: 'b', createdAt: 300 },
        { emoji: 'c', createdAt: 200 },
        { emoji: 'a', createdAt: 400 },
        { emoji: 'b', createdAt: 350 },
      ]),
    ).toEqual(['a', 'b', 'c'])
  })

  it('limits the result to the requested number of emojis', () => {
    expect(
      rankRecentEmojis(
        [
          { emoji: 'a', createdAt: 100 },
          { emoji: 'b', createdAt: 200 },
          { emoji: 'c', createdAt: 300 },
        ],
        2,
      ),
    ).toEqual(['c', 'b'])
  })
})

describe('reaction counts', () => {
  it('adds, reorders by count, and drops emojis that reach zero', () => {
    let counts = applyReactionCountDelta(undefined, 'a', 1)
    counts = applyReactionCountDelta(counts, 'b', 1)
    counts = applyReactionCountDelta(counts, 'b', 1)
    expect(counts).toEqual([
      { emoji: 'b', count: 2 },
      { emoji: 'a', count: 1 },
    ])
    counts = applyReactionCountDelta(counts, 'a', -1)
    expect(counts).toEqual([{ emoji: 'b', count: 2 }])
    expect(sumReactionCounts(counts)).toBe(2)
  })

  it('treats a decrement below zero or of a missing emoji as a no-op', () => {
    expect(applyReactionCountDelta([], 'a', -1)).toEqual([])
    expect(applyReactionCountDelta([{ emoji: 'a', count: 1 }], 'a', -5)).toEqual([])
  })

  it('tallies rows with first-seen order as the tiebreaker', () => {
    expect(
      tallyReactionCounts([{ emoji: 'x' }, { emoji: 'y' }, { emoji: 'y' }, { emoji: 'z' }]),
    ).toEqual([
      { emoji: 'y', count: 2 },
      { emoji: 'x', count: 1 },
      { emoji: 'z', count: 1 },
    ])
  })
})
