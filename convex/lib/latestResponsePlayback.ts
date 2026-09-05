import type { Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { auth } from '../auth'
import {
  buildViewerVisibilityContext,
  isUserContentVisibleToViewer,
  type ViewerVisibilityContext,
} from '../bondfireVisibility'
import { isModeratedContentVisible } from '../contentSafety'

export type VideoPlaybackReference = {
  bondfireVideoId?: Id<'bondfireVideos'>
  muxPlaybackId: string
  muxPlaybackPolicy?: 'public' | 'signed'
}

type VideoPlaybackRecord = {
  _id?: Id<'bondfireVideos'>
  videoStatus?: string
  muxPlaybackId?: string
  muxPlaybackPolicy?: 'public' | 'signed'
  muxLivePlaybackId?: string
  expiresAt?: number
}

export function getPlayableVideoPlayback(
  record: VideoPlaybackRecord,
  now = Date.now(),
): VideoPlaybackReference | null {
  if (record.expiresAt !== undefined && record.expiresAt <= now) {
    return null
  }

  const status = record.videoStatus ?? 'ready'
  if (status === 'ready' && record.muxPlaybackId) {
    return {
      bondfireVideoId: record._id,
      muxPlaybackId: record.muxPlaybackId,
      muxPlaybackPolicy: record.muxPlaybackPolicy,
    }
  }
  if (status === 'live' && record.muxLivePlaybackId) {
    return {
      bondfireVideoId: record._id,
      muxPlaybackId: record.muxLivePlaybackId,
      muxPlaybackPolicy: record.muxPlaybackPolicy,
    }
  }
  return null
}

/** Returns the newest playable response, following the bondfire sequence index. */
export async function getLatestResponsePlayback(
  ctx: QueryCtx,
  bondfireId: Id<'bondfires'>,
  viewerContext?: ViewerVisibilityContext,
): Promise<VideoPlaybackReference | null> {
  const now = Date.now()
  const viewer =
    viewerContext ?? (await buildViewerVisibilityContext(ctx, await auth.getUserId(ctx)))
  const responses = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .order('desc')
    .take(10)
  for (const response of responses) {
    const playback = getPlayableVideoPlayback(response, now)
    if (
      !playback ||
      !isModeratedContentVisible(response.moderationStatus, {
        isOwner: response.userId === viewer.userId,
        isAdmin: viewer.isAdmin,
      })
    )
      continue
    if (await isUserContentVisibleToViewer(ctx, response.userId, viewer)) return playback
  }
  return null
}
