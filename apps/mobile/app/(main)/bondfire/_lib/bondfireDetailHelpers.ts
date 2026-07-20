import type { FlatListProps } from 'react-native'
import { Dimensions } from 'react-native'
import type { Doc, Id } from '../../../../../../convex/_generated/dataModel'
import type { VideoPlaybackUrls } from './bondfireVideoUrlPlan'

export const { width: SCREEN_WIDTH } = Dimensions.get('window')
export const SCRUB_SEEK_THROTTLE_MS = 100
export const REACTION_PLAYBACK_WINDOW_MS = 150
export const REACTION_THROTTLE_MS = 5000
// Processing normally completes within a couple of minutes; past this it is
// likely stuck (missed Mux webhook) and worth a telemetry warning.
export const STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS = 5 * 60 * 1000

export type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

export type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

export type BondfireDetailData = Doc<'bondfires'> & {
  campStatus?: Doc<'camps'>['status']
  campName?: string
  watchedByViewer?: boolean
  videos: (Doc<'bondfireVideos'> & { watchedByViewer?: boolean })[]
  processingResponses?: Array<{
    _id: Id<'bondfireVideos'>
    userId: Id<'users'>
    creatorName?: string
    createdAt: number
  }>
  participants?: ThreadParticipant[]
}

export type ScrollToIndexFailedInfo = Parameters<
  NonNullable<FlatListProps<unknown>['onScrollToIndexFailed']>
>[0]

export type BondfireVideoItem = {
  key: string
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  url: string | null
  videoOwnerId: Id<'users'>
  creatorName: string
  isMainVideo: boolean
  responseIndex?: number
  isLive: boolean
  createdAt: number
  watchedByViewer: boolean
  durationMs?: number
  summary?: string
  aiTags?: string[]
  captionsUrl?: string
}

export function clampVideoIndex(index: number | null | undefined, totalVideos: number) {
  if (totalVideos <= 0) return 0
  if (index === null || index === undefined || !Number.isFinite(index)) return 0

  return Math.max(0, Math.min(Math.floor(index), totalVideos - 1))
}

export function shouldOfferResponseAfterPlayback({
  videoIndex,
  totalVideos,
  canRespond,
}: {
  videoIndex: number
  totalVideos: number
  canRespond: boolean
}) {
  return canRespond && totalVideos > 0 && videoIndex === totalVideos - 1
}

export function getResponseVideoScrollIndex(
  bondfireData: BondfireDetailData,
  responseVideoId: string | null | undefined,
) {
  if (!responseVideoId) return null

  const responseIndex = bondfireData.videos.findIndex((video) => video._id === responseVideoId)
  if (responseIndex < 0) return null

  return responseIndex + 1
}

export function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export { withLiveDvrStart } from './bondfireVideoUrlPlan'

/**
 * Where a bondfire opens: the first video the viewer has not watched yet, so
 * swiping forward walks through everything new. Falls back to the last video
 * when the whole thread has been seen. The viewer's own videos count as
 * watched (watchedByViewer is computed server-side in getWithVideos). A
 * missing flag counts as unwatched. Deep links override this at the call site.
 */
export function getInitialVideoIndex(bondfireData: BondfireDetailData): number {
  const watched = [
    bondfireData.watchedByViewer ?? false,
    ...bondfireData.videos.map((video) => video.watchedByViewer ?? false),
  ]
  const firstUnwatched = watched.indexOf(false)
  return firstUnwatched === -1 ? watched.length - 1 : firstUnwatched
}

export function buildBondfireVideoItems(
  bondfireData: BondfireDetailData,
  videoUrls: (VideoPlaybackUrls | null)[],
): BondfireVideoItem[] {
  return [
    {
      key: bondfireData._id,
      bondfireId: bondfireData._id,
      bondfireVideoId: undefined,
      url: videoUrls[0]?.url ?? null,
      videoOwnerId: bondfireData.userId,
      creatorName: bondfireData.creatorName ?? 'Anonymous',
      isMainVideo: true,
      responseIndex: undefined,
      isLive: bondfireData.videoStatus === 'live',
      createdAt: bondfireData._creationTime,
      watchedByViewer: bondfireData.watchedByViewer ?? false,
      durationMs: bondfireData.durationMs,
      summary: bondfireData.summary,
      aiTags: bondfireData.aiTags,
      captionsUrl: videoUrls[0]?.captionsUrl,
    },
    ...bondfireData.videos.map((video, index) => ({
      key: video._id,
      bondfireId: undefined,
      bondfireVideoId: video._id,
      url: videoUrls[index + 1]?.url ?? null,
      videoOwnerId: video.userId,
      creatorName: video.creatorName ?? 'Anonymous',
      isMainVideo: false,
      responseIndex: index + 1,
      isLive: video.videoStatus === 'live',
      createdAt: video._creationTime,
      watchedByViewer: video.watchedByViewer ?? false,
      durationMs: video.durationMs,
      summary: video.summary,
      aiTags: video.aiTags,
      captionsUrl: videoUrls[index + 1]?.captionsUrl,
    })),
  ]
}
