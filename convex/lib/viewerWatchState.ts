import type { Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * The single definition of "watched" for a spark or response.
 *
 * Shared by the detail screen's initial scroll position
 * (`bondfires.getWithVideos`) and the name on unread My Fires rows
 * (`conversations.listMyFires`) so the two cannot drift. The viewer's own
 * videos always count as watched; anything else is watched once the viewer has
 * any watch event for it. Signed-out viewers have watched nothing.
 */
export async function isVideoWatchedByViewer(
  ctx: QueryCtx,
  viewerId: Id<'users'> | null,
  video: { _id: string; userId: Id<'users'> },
): Promise<boolean> {
  if (!viewerId) return false
  if (video.userId === viewerId) return true
  const event = await ctx.db
    .query('watchEvents')
    .withIndex('by_user_video', (q) => q.eq('userId', viewerId).eq('videoId', video._id))
    .first()
  return event !== null
}
