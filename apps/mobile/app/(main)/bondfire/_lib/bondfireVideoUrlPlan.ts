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

// Only URLs near the current position are fetched — video *content* already
// loads only for the active video, but a 100-response thread should not pay
// for 100 access checks and signed tokens either. The window extends as the
// user swipes; previously fetched URLs stay cached.
export const URL_PREFETCH_BEHIND = 2
export const URL_PREFETCH_AHEAD = 4

export function urlPrefetchWindow(
  currentIndex: number,
  targetCount: number,
): { start: number; end: number } {
  const clampedIndex = Math.min(Math.max(currentIndex, 0), Math.max(targetCount - 1, 0))
  return {
    start: Math.max(0, clampedIndex - URL_PREFETCH_BEHIND),
    end: Math.min(targetCount - 1, clampedIndex + URL_PREFETCH_AHEAD),
  }
}

export function missingUrlRequests(
  targets: readonly VideoUrlTarget[],
  cache: ReadonlyMap<string, string>,
  inFlight?: ReadonlySet<string>,
  window?: { start: number; end: number },
): { cacheKey: string; request: VideoUrlRequest }[] {
  const seen = new Set<string>()
  const missing: { cacheKey: string; request: VideoUrlRequest }[] = []
  targets.forEach((target, index) => {
    if (window && (index < window.start || index > window.end)) return
    if (!target.cacheKey || !target.request) return
    if (cache.has(target.cacheKey) || inFlight?.has(target.cacheKey) || seen.has(target.cacheKey))
      return
    seen.add(target.cacheKey)
    missing.push({ cacheKey: target.cacheKey, request: target.request })
  })
  return missing
}
