import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
} from './bondfireVisibility'
import { requireUgcPermission } from './contentSafety'
import { getEntitlementSubscriptionTier, TIER_RANK } from './entitlements'
import { throwUserError, withUserFacingErrors } from './errors'
import { isFreeEmoji, isReactionEmoji } from './lib/emojis'
import { getVideoLifecycle } from './lib/videoLifecycle'
import {
  countReaction,
  type ReactionCount,
  rankRecentEmojis,
  tallyReactionCounts,
} from './lib/videoReactions'

type VideoReference =
  | { bondfireId: Id<'bondfires'>; bondfireVideoId?: undefined }
  | { bondfireId?: undefined; bondfireVideoId: Id<'bondfireVideos'> }

function hasExactlyOneVideoReference(args: {
  bondfireId?: unknown
  bondfireVideoId?: unknown
}): args is VideoReference {
  return !!args.bondfireId !== !!args.bondfireVideoId
}

function isVodRecordReady(record: Doc<'bondfires'> | Doc<'bondfireVideos'> | null) {
  return record !== null && getVideoLifecycle(record) === 'ready'
}

async function getVodVideo(ctx: MutationCtx | QueryCtx, video: VideoReference) {
  if (video.bondfireId !== undefined) {
    const bondfire = await ctx.db.get(video.bondfireId)
    return bondfire && isVodRecordReady(bondfire) ? { bondfire, response: null } : null
  }
  const response = await ctx.db.get(video.bondfireVideoId)
  if (!response || !isVodRecordReady(response)) return null
  const bondfire = await ctx.db.get(response.bondfireId)
  return bondfire ? { bondfire, response } : null
}

async function getReactionViewer(
  ctx: MutationCtx | QueryCtx,
  video: VideoReference,
  userId: Id<'users'> | null,
) {
  const target = await getVodVideo(ctx, video)
  if (!target) return null
  const viewer = await buildViewerVisibilityContext(ctx, userId)
  if (
    !(await isBondfireVisibleToViewer(ctx, target.bondfire, viewer, {
      allowAdminModerationReview: true,
    }))
  ) {
    return null
  }
  if (target.response) {
    if (!(await isUserContentVisibleToViewer(ctx, target.response.userId, viewer))) {
      return null
    }
    if (
      target.response.moderationStatus === 'removed' ||
      (target.response.moderationStatus === 'pending_review' &&
        userId !== target.response.userId &&
        !viewer.isAdmin)
    ) {
      return null
    }
  }
  return viewer
}

/**
 * Add a timestamped emoji reaction to a VOD video.
 *
 * Exactly one of `bondfireId` or `bondfireVideoId` must be provided.
 * Denormalizes the reactor's displayName + photoUrl at creation time so
 * playback queries never need to join the users table.
 *
 * A server-side rolling limit prevents scripted reaction spam even if the
 * client-side throttle is bypassed.
 */
export const addReaction = mutation({
  args: {
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
    emoji: v.string(),
    timestampMs: v.number(),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'videoReactions.addReaction',
      'Failed to save reaction. Please try again.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throwUserError('Not authenticated')
        }
        await requireUgcPermission(ctx, userId)

        if (!hasExactlyOneVideoReference(args)) {
          throwUserError('Exactly one of bondfireId or bondfireVideoId must be provided')
        }

        if (args.timestampMs < 0) {
          throwUserError('Reaction timestamp must be non-negative')
        }

        if (!isReactionEmoji(args.emoji)) {
          throwUserError('Unsupported reaction emoji')
        }

        if (!isFreeEmoji(args.emoji)) {
          const tier = await getEntitlementSubscriptionTier(ctx, userId)
          if (TIER_RANK[tier] < TIER_RANK.plus) {
            throwUserError('This reaction requires a Plus subscription')
          }
        }

        const [user, viewer] = await Promise.all([
          ctx.db.get(userId),
          getReactionViewer(ctx, args, userId),
        ])
        if (!viewer) throwUserError('Video is unavailable for reactions')
        if (!user) {
          throw new Error('User not found')
        }

        const recent = await ctx.db
          .query('videoReactions')
          .withIndex('by_user_created', (q) =>
            q.eq('userId', userId).gte('createdAt', Date.now() - 10_000),
          )
          .take(10)
        if (recent.length >= 10) {
          throwUserError('Please wait before adding more reactions')
        }

        const row = {
          bondfireId: args.bondfireId,
          bondfireVideoId: args.bondfireVideoId,
          userId,
          userDisplayName: user.displayName ?? user.name,
          userPhotoUrl: user.photoUrl,
          emoji: args.emoji,
          timestampMs: args.timestampMs,
          createdAt: Date.now(),
        }
        const reactionId = await ctx.db.insert('videoReactions', row)
        await countReaction(ctx, row)

        const reaction = await ctx.db.get(reactionId)
        return reaction ?? null
      },
    ),
})

/**
 * Get all reactions for a video, sorted by timestampMs ascending.
 *
 * Exactly one of `bondfireId` or `bondfireVideoId` must be provided.
 * Uses the appropriate index based on which ID is given.
 * Does NOT join the users table — relies on denormalized fields.
 */
export const getReactions = query({
  args: {
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
  },
  handler: async (ctx, args) => {
    if (!hasExactlyOneVideoReference(args)) {
      throwUserError('Exactly one of bondfireId or bondfireVideoId must be provided')
    }

    const userId = await auth.getUserId(ctx)
    const viewer = await getReactionViewer(ctx, args, userId)
    // Read subscriptions can outlive readiness or authorization. Return no
    // reactions instead of throwing into the entire video screen. Writes deny.
    if (!viewer) return []
    if (args.bondfireId) {
      const reactions = await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
        .order('asc')
        .collect()
      const visible = await Promise.all(
        reactions.map((reaction) => isUserContentVisibleToViewer(ctx, reaction.userId, viewer)),
      )
      return reactions.filter((_, index) => visible[index])
    }

    const reactions = await ctx.db
      .query('videoReactions')
      .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', args.bondfireVideoId))
      .order('asc')
      .collect()
    const visible = await Promise.all(
      reactions.map((reaction) => isUserContentVisibleToViewer(ctx, reaction.userId, viewer)),
    )
    return reactions.filter((_, index) => visible[index])
  },
})

/**
 * Get the current user's most frequently used emojis.
 *
 * Aggregates from videoReactions by userId, groups by emoji, counts,
 * sorts descending by count, and returns up to 4 emojis.
 * Used by the emoji grid's "recent" column for paid users.
 */
export const getRecentEmojis = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const reactions = await ctx.db
      .query('videoReactions')
      .withIndex('by_user_created', (q) => q.eq('userId', userId))
      .order('desc')
      .collect()

    return rankRecentEmojis(reactions.filter((reaction) => isReactionEmoji(reaction.emoji)))
  },
})

// ── Reaction summary repair / backfill ──────────────────────────────────────
//
// Recomputes every video's reaction summary and each thread's rollup from the
// videoReactions rows, patching only what disagrees. It writes absolute values,
// so it is safe to rerun and cannot double-count rows the incremental helpers
// already counted. Run once after deploying the summary fields (dashboard →
// videoReactions:repairReactionSummaries {}); it self-paginates.

const REPAIR_BATCH_SIZE = 10

type Summary = { total: number; counts: ReactionCount[]; lastAt?: number; lastUserId?: Id<'users'> }

function summarize(reactions: Doc<'videoReactions'>[]): Summary {
  const counts = tallyReactionCounts(reactions)
  const latest = reactions.reduce<Doc<'videoReactions'> | null>(
    (best, reaction) => (!best || reaction.createdAt >= best.createdAt ? reaction : best),
    null,
  )
  return {
    total: reactions.length,
    counts,
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

export const repairReactionSummaries = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? REPAIR_BATCH_SIZE
    const page = await ctx.db
      .query('bondfires')
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null })

    let repaired = 0
    for (const bondfire of page.page) {
      const sparkReactions = await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      const threadReactions = [...sparkReactions]
      for (const response of responses) {
        const responseReactions = await ctx.db
          .query('videoReactions')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', response._id))
          .collect()
        threadReactions.push(...responseReactions)
        const expected = summarize(responseReactions)
        if (ownSummaryDrifted(response, expected)) {
          repaired += 1
          await ctx.db.patch(response._id, {
            reactionTotal: expected.total,
            reactionCounts: expected.counts,
            lastReactionAt: expected.lastAt,
          })
        }
      }

      const spark = summarize(sparkReactions)
      const thread = summarize(threadReactions)
      const threadDrifted =
        (bondfire.threadReactionTotal ?? 0) !== thread.total ||
        !sameCounts(bondfire.threadReactionCounts, thread.counts) ||
        bondfire.threadLastReactionAt !== thread.lastAt ||
        bondfire.threadLastReactorId !== thread.lastUserId
      if (ownSummaryDrifted(bondfire, spark) || threadDrifted) {
        repaired += 1
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
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.videoReactions.repairReactionSummaries, {
        cursor: page.continueCursor,
        batchSize,
      })
    }

    return { processed: page.page.length, repaired, isDone: page.isDone }
  },
})
