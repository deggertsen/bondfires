import { describe, expect, it } from 'vitest'
import {
  planReactionFlyIn,
  REACTION_FLY_IN_BURST_LIMIT,
  REACTION_FLY_IN_BURST_WINDOW_MS,
  type ReactionFlyInBurst,
} from '../../../packages/app/src/utils/reactionFlyIn'
import { buildReactionFlights } from '../../../packages/ui/src/reactionFlights'

const fresh: ReactionFlyInBurst = { startedAt: 0, count: 0 }
const now = 10_000_000

describe('planReactionFlyIn', () => {
  it('plays from 0 the first time a thread with reactions is shown', () => {
    expect(planReactionFlyIn(undefined, 12, fresh, now).fromTotal).toBe(0)
  })

  it('stays settled when the total has not grown', () => {
    expect(planReactionFlyIn(12, 12, fresh, now).fromTotal).toBeNull()
    expect(planReactionFlyIn(12, 10, fresh, now).fromTotal).toBeNull()
  })

  it('plays from the last shown total when it grew', () => {
    expect(planReactionFlyIn(12, 14, fresh, now).fromTotal).toBe(12)
  })

  it('caps how many rows fly in together, then reopens after the window', () => {
    let burst = fresh
    const results: Array<number | null> = []
    for (let i = 0; i < REACTION_FLY_IN_BURST_LIMIT + 2; i++) {
      const plan = planReactionFlyIn(undefined, 3, burst, now + i * 10)
      results.push(plan.fromTotal)
      burst = plan.burst
    }
    expect(results.filter((value) => value === 0)).toHaveLength(REACTION_FLY_IN_BURST_LIMIT)
    expect(results.slice(REACTION_FLY_IN_BURST_LIMIT)).toEqual([null, null])
    const later = planReactionFlyIn(
      undefined,
      3,
      burst,
      now + REACTION_FLY_IN_BURST_WINDOW_MS + 100,
    )
    expect(later.fromTotal).toBe(0)
  })
})

describe('buildReactionFlights', () => {
  it('sends at most 6 emojis, split by share of the counts', () => {
    const flights = buildReactionFlights(
      [
        { emoji: '❤️', count: 5 },
        { emoji: '🔥', count: 4 },
        { emoji: '🙏', count: 3 },
      ],
      12,
    )
    expect(flights).toHaveLength(6)
    expect(flights.filter((emoji) => emoji === '❤️').length).toBeGreaterThanOrEqual(2)
    expect(new Set(flights)).toEqual(new Set(['❤️', '🔥', '🙏']))
  })

  it('sends one emoji per new reaction for small increases, and none for none', () => {
    expect(buildReactionFlights([{ emoji: '💪', count: 3 }], 2)).toEqual(['💪', '💪'])
    expect(buildReactionFlights([{ emoji: '💪', count: 3 }], 0)).toEqual([])
    expect(buildReactionFlights([], 4)).toEqual([])
  })
})
