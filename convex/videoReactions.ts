import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError, withUserFacingErrors } from './errors'
import { rankRecentEmojis } from './lib/videoReactions'

type VideoReference =
  | { bondfireId: Id<'bondfires'>; bondfireVideoId?: undefined }
  | { bondfireId?: undefined; bondfireVideoId: Id<'bondfireVideos'> }

function hasExactlyOneVideoReference(args: {
  bondfireId?: unknown
  bondfireVideoId?: unknown
}): args is VideoReference {
  return !!args.bondfireId !== !!args.bondfireVideoId
}

function assertVodRecordIsReady(record: Doc<'bondfires'> | Doc<'bondfireVideos'> | null) {
  if (!record) {
    throwUserError('Video not found')
  }

  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    throwUserError('Video not found')
  }

  const status = record.videoStatus ?? 'ready'
  if (status !== 'ready' || !record.muxPlaybackId) {
    throwUserError('Reactions are only available for videos on demand')
  }
}

async function assertVodVideoExists(ctx: MutationCtx, video: VideoReference) {
  if (video.bondfireId !== undefined) {
    assertVodRecordIsReady(await ctx.db.get(video.bondfireId))
    return
  }

  assertVodRecordIsReady(await ctx.db.get(video.bondfireVideoId))
}

/**
 * Add a timestamped emoji reaction to a VOD video.
 *
 * Exactly one of `bondfireId` or `bondfireVideoId` must be provided.
 * Denormalizes the reactor's displayName + photoUrl at creation time so
 * playback queries never need to join the users table.
 *
 * No server-side throttle — throttling is client-side only per spec.
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

        if (!hasExactlyOneVideoReference(args)) {
          throwUserError('Exactly one of bondfireId or bondfireVideoId must be provided')
        }

        if (args.timestampMs < 0) {
          throwUserError('Reaction timestamp must be non-negative')
        }

        const [user] = await Promise.all([ctx.db.get(userId), assertVodVideoExists(ctx, args)])
        if (!user) {
          throw new Error('User not found')
        }

        const reactionId = await ctx.db.insert('videoReactions', {
          bondfireId: args.bondfireId,
          bondfireVideoId: args.bondfireVideoId,
          userId,
          userDisplayName: user.displayName ?? user.name,
          userPhotoUrl: user.photoUrl,
          emoji: args.emoji,
          timestampMs: args.timestampMs,
          createdAt: Date.now(),
        })

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

    if (args.bondfireId) {
      return await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
        .order('asc')
        .collect()
    }

    return await ctx.db
      .query('videoReactions')
      .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', args.bondfireVideoId))
      .order('asc')
      .collect()
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

    return rankRecentEmojis(reactions)
  },
})
