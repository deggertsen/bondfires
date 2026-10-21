import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
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
// Summaries are recomputed from the rows, not counted incrementally, and the
// recompute is coalesced per thread: inserting or deleting a reaction row calls
// requestReactionSummaryFlush, which schedules one flush REACTION_SUMMARY_FLUSH_MS
// later unless one is already pending. A burst of reactions therefore costs one
// summary write per thread instead of one per reaction, so the feed, camp, My
// Fires, and thread queries that read the bondfire re-run once per burst.
// Counts lag the rows by up to that delay; playback reads the rows and is
// unaffected. repairReactionSummaries (videoReactions.ts) runs the same
// recompute over every thread for backfill and drift.

/** How long reactions on one thread coalesce before its summaries are rewritten. */
export const REACTION_SUMMARY_FLUSH_MS = 2_000

export type ReactionCount = { emoji: string; count: number }

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

type SummaryRow = Pick<Doc<'videoReactions'>, 'emoji' | 'userId' | 'createdAt'>

type Summary = {
  total: number
  counts: ReactionCount[]
  lastAt?: number
  lastUserId?: Id<'users'>
}

export function summarizeReactions(reactions: SummaryRow[]): Summary {
  const latest = reactions.reduce<SummaryRow | null>(
    (best, reaction) => (!best || reaction.createdAt >= best.createdAt ? reaction : best),
    null,
  )
  return {
    total: reactions.length,
    counts: tallyReactionCounts(reactions),
    lastAt: latest?.createdAt,
    lastUserId: latest?.userId,
  }
}

function sameCounts(stored: ReactionCount[] | undefined, expected: ReactionCount[]) {
  const byEmoji = new Map((stored ?? []).map((entry) => [entry.emoji, entry.count]))
  return (
    byEmoji.size === expected.length &&
    expected.every((entry) => byEmoji.get(entry.emoji) === entry.count)
  )
}

function ownSummaryDrifted(
  doc: Pick<Doc<'bondfireVideos'>, 'reactionTotal' | 'reactionCounts' | 'lastReactionAt'>,
  expected: Summary,
) {
  return (
    (doc.reactionTotal ?? 0) !== expected.total ||
    !sameCounts(doc.reactionCounts, expected.counts) ||
    doc.lastReactionAt !== expected.lastAt
  )
}

/**
 * Rewrite one thread's summaries (spark, each response, and the rollup) from
 * its reaction rows. Patches only documents whose stored summary disagrees, so
 * an unchanged thread invalidates nothing. Returns how many documents changed.
 * Deliberately leaves bondfire.updatedAt alone: a reaction is not thread
 * activity and must not reorder anything.
 */
export async function recomputeThreadReactionSummaries(
  ctx: MutationCtx,
  bondfire: Doc<'bondfires'>,
): Promise<number> {
  let patched = 0
  const sparkReactions = await ctx.db
    .query('videoReactions')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
    .collect()
  const responses = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
    .collect()

  const threadReactions: SummaryRow[] = [...sparkReactions]
  for (const response of responses) {
    const responseReactions = await ctx.db
      .query('videoReactions')
      .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', response._id))
      .collect()
    threadReactions.push(...responseReactions)
    const expected = summarizeReactions(responseReactions)
    if (ownSummaryDrifted(response, expected)) {
      patched += 1
      await ctx.db.patch(response._id, {
        reactionTotal: expected.total,
        reactionCounts: expected.counts,
        lastReactionAt: expected.lastAt,
      })
    }
  }

  const spark = summarizeReactions(sparkReactions)
  const thread = summarizeReactions(threadReactions)
  const threadDrifted =
    (bondfire.threadReactionTotal ?? 0) !== thread.total ||
    !sameCounts(bondfire.threadReactionCounts, thread.counts) ||
    bondfire.threadLastReactionAt !== thread.lastAt ||
    bondfire.threadLastReactorId !== thread.lastUserId
  if (ownSummaryDrifted(bondfire, spark) || threadDrifted) {
    patched += 1
    await ctx.db.patch(bondfire._id, {
      reactionTotal: spark.total,
      reactionCounts: spark.counts,
      lastReactionAt: spark.lastAt,
      threadReactionTotal: thread.total,
      threadReactionCounts: thread.counts,
      threadLastReactionAt: thread.lastAt,
      threadLastReactorId: thread.lastUserId,
    })
  }
  return patched
}

/**
 * Call in the same mutation that inserts or deletes a reaction row. Schedules
 * the thread's summary flush unless one is already pending, so any number of
 * reaction changes inside one flush window cost a single summary write.
 */
export async function requestReactionSummaryFlush(
  ctx: MutationCtx,
  reaction: Pick<Doc<'videoReactions'>, 'bondfireId' | 'bondfireVideoId'>,
) {
  let bondfireId = reaction.bondfireId
  if (!bondfireId && reaction.bondfireVideoId) {
    const response = await ctx.db.get(reaction.bondfireVideoId)
    bondfireId = response?.bondfireId
  }
  if (!bondfireId) return
  const pending = await ctx.db
    .query('reactionSummaryFlushes')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .first()
  if (pending) return
  await ctx.db.insert('reactionSummaryFlushes', { bondfireId, requestedAt: Date.now() })
  await ctx.scheduler.runAfter(
    REACTION_SUMMARY_FLUSH_MS,
    internal.videoReactions.flushReactionSummaries,
    { bondfireId },
  )
}
