import { observable } from '@legendapp/state'
import { syncObservable } from '@legendapp/state/sync'
import { planReactionFlyIn, type ReactionFlyInBurst } from '../utils/reactionFlyIn'

// The reaction total this device last showed for each thread. A row plays the
// fly-in only when its total has grown past this, so a quiet feed stays still
// and the same reactions don't fly in twice on one device.
interface ReactionFlyInState {
  [bondfireId: string]: number
}

export const reactionFlyInTotals$ = observable<ReactionFlyInState>({})

syncObservable(reactionFlyInTotals$, {
  persist: {
    name: 'reaction-fly-in-totals',
  },
})

let burst: ReactionFlyInBurst = { startedAt: 0, count: 0 }

/**
 * Called by a row's reaction chip once it is on screen. Returns the total to
 * fly in from, or null to render the chip settled.
 */
export function claimReactionFlyIn(bondfireId: string, total: number): number | null {
  const lastShown = reactionFlyInTotals$[bondfireId].peek()
  const plan = planReactionFlyIn(lastShown, total, burst, Date.now())
  burst = plan.burst
  if (total > (lastShown ?? 0)) reactionFlyInTotals$[bondfireId].set(total)
  return plan.fromTotal
}
