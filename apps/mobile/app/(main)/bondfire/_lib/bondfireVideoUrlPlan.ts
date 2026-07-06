import type { Id } from '../../../../../../convex/_generated/dataModel'
import type { BondfireDetailData } from './bondfireDetailHelpers'

export function withLiveDvrStart(url: string, isLive: boolean): string {
  if (!isLive) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}start=0`
}

export type VideoUrlRequest = {
  muxPlaybackId: string
  muxPlaybackPolicy?: 'public' | 'signed'
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}

/**
 * One entry per screen position: index 0 is the main video, index i+1 is
 * bondfireData.videos[i]. Positions stay aligned even when a video in the
 * middle is not playable yet — its cacheKey/request are null and its URL
 * resolves to null instead of shifting every later video's URL up a slot.
 */
export type VideoUrlTarget = {
  cacheKey: string | null
  request: VideoUrlRequest | null
  isLive: boolean
}

type PlayableVideoFields = Pick<
  BondfireDetailData,
  'videoStatus' | 'muxLivePlaybackId' | 'muxPlaybackId'
>

export function getPlaybackIdForVideo(video: PlayableVideoFields) {
  return (video.videoStatus ?? 'ready') === 'live' ? video.muxLivePlaybackId : video.muxPlaybackId
}

export function shouldLoadMainVideoUrls(bondfireData: BondfireDetailData) {
  const status = bondfireData.videoStatus ?? 'ready'
  return status === 'ready' || status === 'live'
}

export function buildVideoUrlTargets(bondfireData: BondfireDetailData): VideoUrlTarget[] {
  const mainIsLive = bondfireData.videoStatus === 'live'
  const mainPlaybackId = shouldLoadMainVideoUrls(bondfireData)
    ? getPlaybackIdForVideo(bondfireData)
    : null

  const targets: VideoUrlTarget[] = [
    mainPlaybackId
      ? {
          cacheKey: `${mainPlaybackId}|${bondfireData.muxPlaybackPolicy ?? 'public'}|bondfire:${bondfireData._id}`,
          request: {
            muxPlaybackId: mainPlaybackId,
            muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
            bondfireId: bondfireData._id,
          },
          isLive: mainIsLive,
        }
      : { cacheKey: null, request: null, isLive: mainIsLive },
  ]

  for (const video of bondfireData.videos) {
    const isLive = video.videoStatus === 'live'
    const playbackId = getPlaybackIdForVideo(video)
    targets.push(
      playbackId
        ? {
            cacheKey: `${playbackId}|${video.muxPlaybackPolicy ?? 'public'}|response:${video._id}`,
            request: {
              muxPlaybackId: playbackId,
              muxPlaybackPolicy: video.muxPlaybackPolicy,
              bondfireVideoId: video._id,
            },
            isLive,
          }
        : { cacheKey: null, request: null, isLive },
    )
  }

  return targets
}

export function urlsFromCache(
  targets: readonly VideoUrlTarget[],
  cache: ReadonlyMap<string, string>,
): (string | null)[] {
  return targets.map((target) => {
    if (!target.cacheKey) return null
    const url = cache.get(target.cacheKey)
    return url ? withLiveDvrStart(url, target.isLive) : null
  })
}

export function missingUrlRequests(
  targets: readonly VideoUrlTarget[],
  cache: ReadonlyMap<string, string>,
  inFlight?: ReadonlySet<string>,
): { cacheKey: string; request: VideoUrlRequest }[] {
  const seen = new Set<string>()
  const missing: { cacheKey: string; request: VideoUrlRequest }[] = []
  for (const target of targets) {
    if (!target.cacheKey || !target.request) continue
    if (cache.has(target.cacheKey) || inFlight?.has(target.cacheKey) || seen.has(target.cacheKey))
      continue
    seen.add(target.cacheKey)
    missing.push({ cacheKey: target.cacheKey, request: target.request })
  }
  return missing
}
