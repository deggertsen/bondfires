import { v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { withUserFacingErrors } from './errors'

// A presence entry is considered stale if its last heartbeat is older than
// this threshold. The cleanup cron uses this to prune abandoned rows, and
// listViewers uses it to exclude stale entries from the active viewer list.
const PRESENCE_STALE_MS = 65_000 // 65 seconds

/**
 * Heartbeat — upserts a presence row for the current user + video.
 *
 * If a presence row already exists for (videoType, videoId, userId), its
 * lastHeartbeatAt is updated. Otherwise a new row is inserted with
 * denormalized userName + userPhotoUrl from the users table.
 */
export const heartbeat = mutation({
  args: {
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
    videoId: v.string(),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'presence.heartbeat',
      'Failed to update presence. Please try again.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throw new Error('Not authenticated')
        }

        // Look for an existing presence row for this user + video
        const existing = await ctx.db
          .query('presence')
          .withIndex('by_video_user', (q) =>
            q.eq('videoType', args.videoType).eq('videoId', args.videoId).eq('userId', userId),
          )
          .first()

        const now = Date.now()

        if (existing) {
          // Update heartbeat timestamp on existing row
          await ctx.db.patch(existing._id, { lastHeartbeatAt: now })
          return existing._id
        }

        // Denormalize user info for the new presence row
        const user = await ctx.db.get(userId)
        if (!user) {
          throw new Error('User not found')
        }

        const presenceId = await ctx.db.insert('presence', {
          videoType: args.videoType,
          videoId: args.videoId,
          userId,
          userName: user.displayName ?? user.name ?? 'User',
          userPhotoUrl: user.photoUrl,
          lastHeartbeatAt: now,
          createdAt: now,
        })

        return presenceId
      },
    ),
})

/**
 * Leave viewing — deletes the presence row for the current user + video.
 * Called on unmount/blur when the user navigates away from the video.
 */
export const leaveViewing = mutation({
  args: {
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
    videoId: v.string(),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'presence.leaveViewing',
      'Failed to leave viewing session.',
      async () => {
        const userId = await auth.getUserId(ctx)
        if (!userId) {
          throw new Error('Not authenticated')
        }

        const existing = await ctx.db
          .query('presence')
          .withIndex('by_video_user', (q) =>
            q.eq('videoType', args.videoType).eq('videoId', args.videoId).eq('userId', userId),
          )
          .first()

        if (existing) {
          await ctx.db.delete(existing._id)
        }

        return null
      },
    ),
})

/**
 * List active viewers for a video.
 *
 * Returns all presence rows for the given video. Per spec, does NOT filter
 * stale entries on the read path — the cleanup cron (running every minute)
 * handles expiry. The client is responsible for excluding the current
 * user from the display list.
 *
 * Does NOT join the users table — uses denormalized userName + userPhotoUrl.
 */
export const listViewers = query({
  args: {
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
    videoId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('presence')
      .withIndex('by_video', (q) =>
        q.eq('videoType', args.videoType).eq('videoId', args.videoId),
      )
      .collect()
  },
})

/**
 * Internal mutation — cleanup stale presence entries.
 *
 * Deletes all presence rows where lastHeartbeatAt is older than the stale
 * threshold. Runs every 1 minute via cron. Logs the number of rows cleaned up.
 */
export const cleanupStalePresence = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRESENCE_STALE_MS

    const stale = await ctx.db
      .query('presence')
      .withIndex('by_heartbeat', (q) => q.lt('lastHeartbeatAt', cutoff))
      .collect()

    for (const row of stale) {
      await ctx.db.delete(row._id)
    }

    console.log(
      `cleanupStalePresence: removed ${stale.length} stale presence entries`,
    )

    return { cleanedUp: stale.length }
  },
})