import type { Id } from '../../../convex/_generated/dataModel'

export type BondfireThumbnailFields = {
  muxPlaybackId?: string
  muxPlaybackPolicy?: 'public' | 'signed'
  latestResponseBondfireVideoId?: Id<'bondfireVideos'>
  latestResponseMuxPlaybackId?: string
  latestResponseMuxPlaybackPolicy?: 'public' | 'signed'
}

export type BondfireThumbnailPlayback = {
  bondfireVideoId?: Id<'bondfireVideos'>
  cacheKey: string
  muxPlaybackId: string
  muxPlaybackPolicy?: 'public' | 'signed'
}

export function getBondfireThumbnailPlayback(
  bondfire: BondfireThumbnailFields & { _id: string },
): BondfireThumbnailPlayback | null {
  if (bondfire.latestResponseMuxPlaybackId) {
    return {
      bondfireVideoId: bondfire.latestResponseBondfireVideoId,
      cacheKey: `${bondfire._id}:${bondfire.latestResponseMuxPlaybackId}`,
      muxPlaybackId: bondfire.latestResponseMuxPlaybackId,
      muxPlaybackPolicy: bondfire.latestResponseMuxPlaybackPolicy,
    }
  }
  if (!bondfire.muxPlaybackId) return null
  return {
    cacheKey: `${bondfire._id}:${bondfire.muxPlaybackId}`,
    muxPlaybackId: bondfire.muxPlaybackId,
    muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
  }
}

export function getCachedBondfireThumbnail(
  bondfire: BondfireThumbnailFields & { _id: string },
  thumbnailUrls: Record<string, string | null>,
) {
  const playback = getBondfireThumbnailPlayback(bondfire)
  return playback ? (thumbnailUrls[playback.cacheKey] ?? null) : null
}
