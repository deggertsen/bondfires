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
  if (!bondfire.muxPlaybackId) return null
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
