import { describe, expect, it } from 'vitest'
import { rankRecentEmojis } from './videoReactions'

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
