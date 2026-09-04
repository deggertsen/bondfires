import type { Id } from '../../../convex/_generated/dataModel'

export type BondfireThumbnailFields = {
  muxPlaybackId?: string
  muxPlaybackPolicy?: 'public' | 'signed'
  /** Live sparks only expose muxLivePlaybackId until the VOD is ready. */
  muxLivePlaybackId?: string
  videoStatus?: string
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

export type BondfireThumbnailRequest = {
  muxPlaybackId: string
  muxPlaybackPolicy?: 'public' | 'signed'
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}

export type PendingBondfireThumbnail = {
  bondfireId: string
  cacheKey: string
  request: BondfireThumbnailRequest
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
  if (!bondfire.muxPlaybackId) {
    // Live fires have no VOD playback id yet — fall back to the live stream's
    // playback id so the rail shows the live frame instead of a plain flame.
    if (bondfire.videoStatus !== 'live' || !bondfire.muxLivePlaybackId) return null
    return {
      cacheKey: `${bondfire._id}:${bondfire.muxLivePlaybackId}`,
      muxPlaybackId: bondfire.muxLivePlaybackId,
      muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
    }
  }
  return {
    cacheKey: `${bondfire._id}:${bondfire.muxPlaybackId}`,
    muxPlaybackId: bondfire.muxPlaybackId,
    muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
  }
}

export function getCachedBondfireThumbnail(
  bondfire: BondfireThumbnailFields & { _id: string },
  thumbnailUrls: Record<string, string | null | undefined>,
) {
  const playback = getBondfireThumbnailPlayback(bondfire)
  return playback ? (thumbnailUrls[playback.cacheKey] ?? null) : null
}

/**
 * Build one ordered request batch while skipping thumbnails that are cached,
 * already loading, missing playback data, or duplicated in the input window.
 */
export function getPendingBondfireThumbnails(
  bondfires: Array<BondfireThumbnailFields & { _id: string }>,
  thumbnailUrls: Record<string, string | null | undefined>,
  loadingKeys: ReadonlySet<string>,
): PendingBondfireThumbnail[] {
  const pending: PendingBondfireThumbnail[] = []
  const seenKeys = new Set<string>()

  for (const bondfire of bondfires) {
    const playback = getBondfireThumbnailPlayback(bondfire)
    if (!playback) continue
    if (thumbnailUrls[playback.cacheKey] !== undefined) continue
    if (loadingKeys.has(playback.cacheKey) || seenKeys.has(playback.cacheKey)) continue

    seenKeys.add(playback.cacheKey)
    pending.push({
      bondfireId: bondfire._id,
      cacheKey: playback.cacheKey,
      request: {
        muxPlaybackId: playback.muxPlaybackId,
        muxPlaybackPolicy: playback.muxPlaybackPolicy,
        bondfireId: playback.bondfireVideoId ? undefined : (bondfire._id as Id<'bondfires'>),
        bondfireVideoId: playback.bondfireVideoId,
      },
    })
  }

  return pending
}
