import { claimReactionFlyIn } from '@bondfires/app'

type ThreadReactionFields = {
  _id: string
  threadReactionCounts?: Array<{ emoji: string; count: number }>
  threadReactionTotal?: number
  hasNewReactions?: boolean
}

/** BondfireRow props for a thread's reaction chip, including its fly-in claim. */
export function getThreadReactionRowProps(thread: ThreadReactionFields) {
  return {
    reactionCounts: thread.threadReactionCounts,
    reactionTotal: thread.threadReactionTotal,
    hasNewReactions: thread.hasNewReactions ?? false,
    onRequestReactionFlyIn: (total: number) => claimReactionFlyIn(thread._id, total),
  }
}
