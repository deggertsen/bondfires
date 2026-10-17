import type { FunctionReturnType } from 'convex/server'
import type { FlatListProps } from 'react-native'
import { Dimensions } from 'react-native'
import type { api } from '../../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../../convex/_generated/dataModel'
import type { VideoPlaybackUrls } from './bondfireVideoUrlPlan'

export const { width: SCREEN_WIDTH } = Dimensions.get('window')
export const SCRUB_SEEK_THROTTLE_MS = 100
export const REACTION_PLAYBACK_WINDOW_MS = 150
export const REACTION_THROTTLE_MS = 5000
// Processing normally completes within a couple of minutes; past this it is
// likely stalled and worth a telemetry warning.
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
    sequenceNumber?: number
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
  isSegmented?: boolean
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

/** Watched flags in thread order (main video first); a missing flag is unwatched. */
export function getViewerWatchedFlags(bondfireData: BondfireDetailData): boolean[] {
  return [
    bondfireData.watchedByViewer ?? false,
    ...bondfireData.videos.map((video) => video.watchedByViewer ?? false),
  ]
}

/**
 * Where a bondfire opens: the first unwatched LOADED video (spark + newest
 * page by default). Unloaded history is unknown, never implicitly watched.
 * Swiping forward walks through the loaded new videos; older history is an
 * explicit browser action. My Fires still names the global first unwatched
 * responder using the same server-side watch definition. Falls back to the
 * last loaded video when this window has been seen. The viewer's own videos count as
 * watched (watchedByViewer is computed server-side in getWithVideos). A
 * missing flag counts as unwatched. Deep links override this at the call site.
 */
export function getInitialVideoIndex(bondfireData: BondfireDetailData): number {
  const watched = getViewerWatchedFlags(bondfireData)
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
      isLive:
        bondfireData.videoStatus === 'live' &&
        !!(bondfireData.muxLivePlaybackId || bondfireData.segmentRecordingId),
      isSegmented: !!bondfireData.segmentRecordingId,
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
      isLive:
        video.videoStatus === 'live' && !!(video.muxLivePlaybackId || video.segmentRecordingId),
      isSegmented: !!video.segmentRecordingId,
      createdAt: video._creationTime,
      watchedByViewer: video.watchedByViewer ?? false,
      durationMs: video.durationMs,
      summary: video.summary,
      aiTags: video.aiTags,
      captionsUrl: videoUrls[index + 1]?.captionsUrl,
    })),
  ]
}

/** Merge reactive pages by identity, in ascending thread order. Counts describe
 * loaded videos only; the spark is always present exactly once, before responses. */
export function mergeBondfireResponsePages(
  metadata: BondfireDetailData,
  pages: FunctionReturnType<typeof api.bondfires.getResponsePage>['page'],
): BondfireDetailData {
  const rows = [...new Map(pages.map((row) => [row.video._id, row])).values()].sort(
    (a, b) =>
      a.video.sequenceNumber - b.video.sequenceNumber ||
      String(a.video._id).localeCompare(String(b.video._id)),
  )
  const participants = new Map(
    (metadata.participants ?? []).map((entry) => [entry.user._id, { ...entry }]),
  )
  const videos: BondfireDetailData['videos'] = []
  const processingResponses: NonNullable<BondfireDetailData['processingResponses']> = []
  for (const row of rows) {
    if (row.kind === 'processing') {
      processingResponses.push(row.video)
      continue
    }
    videos.push(row.video)
    if (!row.participant) continue
    const previous = participants.get(row.video.userId)
    participants.set(row.video.userId, {
      ...row.participant,
      videoCount: (previous?.videoCount ?? 0) + 1,
      latestAt: Math.max(previous?.latestAt ?? 0, row.video.createdAt),
    })
  }
  return {
    ...metadata,
    videos,
    processingResponses,
    participants: [...participants.values()].sort((a, b) => b.latestAt - a.latestAt),
  }
}

/** A missing target is pending until every older page has been tried. Never
 * silently fall back to first-unwatched while a deep link can still resolve. */
export function getResponseDeepLinkState(
  data: BondfireDetailData,
  responseId: string | undefined,
  hasOlder: boolean,
) {
  if (!responseId) return 'none'
  if (getResponseVideoScrollIndex(data, responseId) !== null) return 'resolved'
  return hasOlder ? 'loading' : 'unavailable'
}

/** Preserve the playing identity when older pages prepend or live rows change. */
export function getRetainedVideoIndex(
  previousKeys: string[],
  nextKeys: string[],
  currentIndex: number,
) {
  const nextIndex = nextKeys.indexOf(previousKeys[currentIndex])
  return nextIndex < 0 ? clampVideoIndex(currentIndex, nextKeys.length) : nextIndex
}
