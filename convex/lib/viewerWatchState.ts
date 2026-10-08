import type { Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * Whether a viewer's watch events for one video mean they watched it: a
 * `complete` event (recorded once playback reaches the last stretch; the
 * server accepts it from 85% of the duration). A video with no known duration,
 * such as one still live, can never record `complete`, so any event counts.
 * Events written before this rule was deployed have no completionRequired
 * marker and retain their original meaning, regardless of the deployment date.
 */
export function isWatchedFromEvents(
  events: { eventType: string; completionRequired?: boolean }[],
  durationMs: number | undefined,
): boolean {
  const canComplete = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
  return events.some(
    (event) => event.eventType === 'complete' || !canComplete || event.completionRequired !== true,
  )
}

/**
 * The single definition of "watched" for a spark or response.
 *
 * Shared by the detail screen's initial scroll position
 * (`bondfires.getWithVideos`) and the name on unread My Fires rows
 * (`conversations.listMyFires`) so the two cannot drift. The viewer's own
 * videos always count as watched; anything else is watched once the viewer has
 * finished it (see `isWatchedFromEvents`). Signed-out viewers have watched
 * nothing.
 */
export async function isVideoWatchedByViewer(
  ctx: QueryCtx,
  viewerId: Id<'users'> | null,
  video: { _id: string; userId: Id<'users'>; durationMs?: number },
): Promise<boolean> {
  if (!viewerId) return false
  if (video.userId === viewerId) return true
  // At most one event per type (record rejects duplicates), so this is tiny.
  const events = await ctx.db
    .query('watchEvents')
    .withIndex('by_user_video', (q) => q.eq('userId', viewerId).eq('videoId', video._id))
    .collect()
  return isWatchedFromEvents(events, video.durationMs)
}
