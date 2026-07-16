import type { Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

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
): Promise<VideoPlaybackReference | null> {
  const now = Date.now()
  const response = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .order('desc')
    .filter((q) =>
      q.and(
        q.or(q.eq(q.field('expiresAt'), undefined), q.gt(q.field('expiresAt'), now)),
        q.or(
          q.and(
            q.or(q.eq(q.field('videoStatus'), undefined), q.eq(q.field('videoStatus'), 'ready')),
            q.neq(q.field('muxPlaybackId'), undefined),
          ),
          q.and(
            q.eq(q.field('videoStatus'), 'live'),
            q.neq(q.field('muxLivePlaybackId'), undefined),
          ),
        ),
      ),
    )
    .first()

  return response ? getPlayableVideoPlayback(response) : null
}
