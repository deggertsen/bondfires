import { claimReactionFlyIn, reactionFlyInTotals$ } from '@bondfires/app'

type ThreadReactionFields = {
  _id: string
  threadReactionCounts?: Array<{ emoji: string; count: number }>
  threadReactionTotal?: number
  hasNewReactions?: boolean
}

/**
 * BondfireRow props for a thread's reaction chip. The fly-in claim is offered
 * only when this device hasn't shown the current total yet, so settled rows
 * (nearly all of them) render a plain chip with no animation hooks and no
 * on-screen measurement.
 */
export function getThreadReactionRowProps(thread: ThreadReactionFields) {
  const total = thread.threadReactionTotal ?? 0
  const hasUnshownReactions = total > (reactionFlyInTotals$[thread._id].peek() ?? 0)
  return {
    reactionCounts: thread.threadReactionCounts,
    reactionTotal: thread.threadReactionTotal,
    hasNewReactions: thread.hasNewReactions ?? false,
    onRequestReactionFlyIn: hasUnshownReactions
      ? (nextTotal: number) => claimReactionFlyIn(thread._id, nextTotal)
      : undefined,
  }
}
