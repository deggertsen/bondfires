export type ReactionChipCount = { emoji: string; count: number }

export const MAX_FLYING_EMOJIS = 6

/** Split up to `limit` flying emojis by each emoji's share of the counts. */
export function buildReactionFlights(counts: ReactionChipCount[], limit: number): string[] {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  const flights = Math.min(limit, MAX_FLYING_EMOJIS, total)
  if (flights <= 0) return []
  const remaining = counts.map((entry) => entry.count)
  const out: string[] = []
  while (out.length < flights) {
    let best = 0
    remaining.forEach((value, index) => {
      if (value > remaining[best]) best = index
    })
    out.push(counts[best].emoji)
    remaining[best] -= total / flights
  }
  return out
}
