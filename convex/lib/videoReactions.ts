import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

export const MAX_RECENT_EMOJIS = 4

export type EmojiUsage = {
  emoji: string
  createdAt: number
}

export function rankRecentEmojis(reactions: EmojiUsage[], limit = MAX_RECENT_EMOJIS): string[] {
  const stats = new Map<string, { count: number; mostRecentAt: number; firstSeenIndex: number }>()

  reactions.forEach((reaction, index) => {
    const current = stats.get(reaction.emoji)
    if (current) {
      current.count += 1
      current.mostRecentAt = Math.max(current.mostRecentAt, reaction.createdAt)
      return
    }

    stats.set(reaction.emoji, {
      count: 1,
      mostRecentAt: reaction.createdAt,
      firstSeenIndex: index,
    })
  })

  return [...stats.entries()]
    .sort((a, b) => {
      if (b[1].count !== a[1].count) {
        return b[1].count - a[1].count
      }
      if (b[1].mostRecentAt !== a[1].mostRecentAt) {
        return b[1].mostRecentAt - a[1].mostRecentAt
      }
      return a[1].firstSeenIndex - b[1].firstSeenIndex
    })
    .slice(0, limit)
    .map(([emoji]) => emoji)
}

// ── Reaction summaries ──────────────────────────────────────────────────────
//
// Lists show reaction counts without loading videoReactions rows. Each video
// keeps its own summary (reactionTotal / reactionCounts / lastReactionAt on
// the bondfire for the spark, on bondfireVideos for a response), and the
// bondfire also keeps a thread* rollup across the spark and every response.
//
// Every insert and delete of a reaction row goes through countReaction /
// uncountReaction in the same mutation, so the row and its counts change
// together. repairReactionSummaries (videoReactions.ts) recomputes them from
// the rows for backfill and drift.

export type ReactionCount = { emoji: string; count: number }

type SummarizedReaction = Pick<
  Doc<'videoReactions'>,
  'bondfireId' | 'bondfireVideoId' | 'emoji' | 'userId' | 'createdAt'
>

/** Highest count first; ties keep their existing order. */
export function sortReactionCounts(counts: ReactionCount[]): ReactionCount[] {
  return counts
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.count - a.entry.count || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Apply a signed change to one emoji's count. Counts never go below zero and
 * emojis at zero are dropped, so a repeated decrement is a no-op.
 */
export function applyReactionCountDelta(
  counts: ReactionCount[] | undefined,
  emoji: string,
  delta: number,
): ReactionCount[] {
  const next = (counts ?? []).map((entry) => ({ ...entry }))
  const existing = next.find((entry) => entry.emoji === emoji)
  if (existing) {
    existing.count = Math.max(0, existing.count + delta)
  } else if (delta > 0) {
    next.push({ emoji, count: delta })
  }
  return sortReactionCounts(next.filter((entry) => entry.count > 0))
}

export function sumReactionCounts(counts: ReactionCount[] | undefined): number {
  return (counts ?? []).reduce((total, entry) => total + entry.count, 0)
}

/** Count reaction rows by emoji, in the order each emoji first appears. */
export function tallyReactionCounts(reactions: Array<{ emoji: string }>): ReactionCount[] {
  let counts: ReactionCount[] = []
  for (const reaction of reactions) counts = applyReactionCountDelta(counts, reaction.emoji, 1)
  return counts
}

type OwnSummary = Pick<Doc<'bondfireVideos'>, 'reactionTotal' | 'reactionCounts' | 'lastReactionAt'>
type ThreadSummary = Pick<
  Doc<'bondfires'>,
  'threadReactionTotal' | 'threadReactionCounts' | 'threadLastReactionAt' | 'threadLastReactorId'
>

function ownSummaryPatch(doc: OwnSummary, reaction: SummarizedReaction, delta: 1 | -1) {
  const reactionCounts = applyReactionCountDelta(doc.reactionCounts, reaction.emoji, delta)
  return {
    reactionCounts,
    reactionTotal: sumReactionCounts(reactionCounts),
    lastReactionAt:
      delta > 0 ? Math.max(doc.lastReactionAt ?? 0, reaction.createdAt) : doc.lastReactionAt,
  }
}

function threadSummaryPatch(doc: ThreadSummary, reaction: SummarizedReaction, delta: 1 | -1) {
  const threadReactionCounts = applyReactionCountDelta(
    doc.threadReactionCounts,
    reaction.emoji,
    delta,
  )
  const isLatest = delta > 0 && reaction.createdAt >= (doc.threadLastReactionAt ?? 0)
  return {
    threadReactionCounts,
    threadReactionTotal: sumReactionCounts(threadReactionCounts),
    threadLastReactionAt: isLatest ? reaction.createdAt : doc.threadLastReactionAt,
    threadLastReactorId: isLatest ? reaction.userId : doc.threadLastReactorId,
  }
}

// Deliberately leaves bondfire.updatedAt alone: a reaction is not thread
// activity and must not reorder anything.
async function applyReactionToSummaries(
  ctx: MutationCtx,
  reaction: SummarizedReaction,
  delta: 1 | -1,
) {
  if (reaction.bondfireVideoId) {
    const response = await ctx.db.get(reaction.bondfireVideoId)
    if (!response) return
    await ctx.db.patch(response._id, ownSummaryPatch(response, reaction, delta))
    const bondfire = await ctx.db.get(response.bondfireId)
    if (bondfire) await ctx.db.patch(bondfire._id, threadSummaryPatch(bondfire, reaction, delta))
    return
  }
  if (!reaction.bondfireId) return
  const bondfire = await ctx.db.get(reaction.bondfireId)
  if (!bondfire) return
  await ctx.db.patch(bondfire._id, {
    ...ownSummaryPatch(bondfire, reaction, delta),
    ...threadSummaryPatch(bondfire, reaction, delta),
  })
}

/** Add a just-inserted reaction row to its video's and thread's summaries. */
export async function countReaction(ctx: MutationCtx, reaction: SummarizedReaction) {
  await applyReactionToSummaries(ctx, reaction, 1)
}

/** Remove a reaction row's counts. Call it in the same mutation that deletes the row. */
export async function uncountReaction(ctx: MutationCtx, reaction: SummarizedReaction) {
  await applyReactionToSummaries(ctx, reaction, -1)
}
