import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { withUserFacingErrors } from './errors'

// Maximum number of recent emojis to return for the emoji grid's recent column.
const MAX_RECENT_EMOJIS = 4

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
          throw new Error('Not authenticated')
        }

        // Validate exactly one video reference is set
        if (
          (!args.bondfireId && !args.bondfireVideoId) ||
          (args.bondfireId && args.bondfireVideoId)
        ) {
          throw new Error(
            'Exactly one of bondfireId or bondfireVideoId must be provided',
          )
        }

        // Denormalize user display info at creation time
        const user = await ctx.db.get(userId)
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
    if (
      (!args.bondfireId && !args.bondfireVideoId) ||
      (args.bondfireId && args.bondfireVideoId)
    ) {
      throw new Error(
        'Exactly one of bondfireId or bondfireVideoId must be provided',
      )
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
      .withIndex('by_bondfire_video', (q) =>
        q.eq('bondfireVideoId', args.bondfireVideoId!),
      )
      .order('asc')
      .collect()
  },
})

/**
 * Get a user's most frequently used emojis.
 *
 * Aggregates from videoReactions by userId, groups by emoji, counts,
 * sorts descending by count, and returns up to 4 emojis.
 * Used by the emoji grid's "recent" column for paid users.
 */
export const getRecentEmojis = query({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    // Fetch all reactions by this user, ordered by creation time descending
    // so we can use recency as a tiebreaker.
    const reactions = await ctx.db
      .query('videoReactions')
      .withIndex('by_user_video', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()

    // Aggregate: count occurrences of each emoji
    const emojiCounts = new Map<string, number>()
    for (const reaction of reactions) {
      const count = emojiCounts.get(reaction.emoji) ?? 0
      emojiCounts.set(reaction.emoji, count + 1)
    }

    // Sort by count descending; ties broken by most recent usage (first
    // occurrence in the desc-ordered reactions list wins).
    const ranked = [...emojiCounts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1]
      }
      // Tiebreaker: which emoji appeared most recently? Find first
      // occurrence in the reactions array (already desc by createdAt).
      const aFirst = reactions.findIndex((r) => r.emoji === a[0])
      const bFirst = reactions.findIndex((r) => r.emoji === b[0])
      return aFirst - bFirst
    })

    return ranked.slice(0, MAX_RECENT_EMOJIS).map(([emoji]) => emoji)
  },
})