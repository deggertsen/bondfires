import { describe, expect, it } from 'vitest'
import { ALL_EMOJIS, FREE_EMOJIS, isFreeEmoji, isReactionEmoji } from './emojis'

describe('reaction emoji catalog', () => {
  it('keeps every free emoji in the supported reaction set', () => {
    for (const emoji of FREE_EMOJIS) {
      expect(isReactionEmoji(emoji)).toBe(true)
      expect(isFreeEmoji(emoji)).toBe(true)
    }
  })

  it('distinguishes paid supported emojis from unsupported input', () => {
    expect(isReactionEmoji(ALL_EMOJIS[3])).toBe(true)
    expect(isFreeEmoji(ALL_EMOJIS[3])).toBe(false)
    expect(isReactionEmoji('not-an-emoji')).toBe(false)
  })
})
