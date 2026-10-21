/** At most this many rows fly in together, so a first launch isn't a swarm. */
export const REACTION_FLY_IN_BURST_LIMIT = 4
/** Rows that ask within this long of a burst's first row share its limit. */
export const REACTION_FLY_IN_BURST_WINDOW_MS = 1500

export type ReactionFlyInBurst = { startedAt: number; count: number }

/**
 * Pure decision behind claimReactionFlyIn: play from `lastShown` when the
 * total grew and the current burst has room. Either way the new total counts
 * as shown, so a row skipped for the limit settles instead of retrying.
 */
export function planReactionFlyIn(
  lastShown: number | undefined,
  total: number,
  burst: ReactionFlyInBurst,
  now: number,
): { fromTotal: number | null; burst: ReactionFlyInBurst } {
  const from = lastShown ?? 0
  if (total <= from) return { fromTotal: null, burst }
  const current =
    now - burst.startedAt > REACTION_FLY_IN_BURST_WINDOW_MS ? { startedAt: now, count: 0 } : burst
  if (current.count >= REACTION_FLY_IN_BURST_LIMIT) return { fromTotal: null, burst: current }
  return { fromTotal: from, burst: { startedAt: current.startedAt, count: current.count + 1 } }
}
