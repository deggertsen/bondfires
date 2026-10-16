import type { Observable } from '@legendapp/state'
import type { AppStateStatus } from 'react-native'
import type { ActiveReaction } from '../../../../components/ViewerPresenceStack'

export type ProgressBarMetrics = {
  width: number
  pageX: number | null
}

export type PendingScrubSeek = {
  locationX: number | null
  timeout: ReturnType<typeof setTimeout> | null
  lastSeekAt: number
}

export type VideoPlayerState = {
  showReport: boolean
  progress: number
  duration: number
  captionText: string
  isLoading: boolean
  /** Player hit a fatal error or buffered past the give-up timeout; retry UI shown. */
  hasError: boolean
  isPlaying: boolean
  userInitiatedPlay: boolean
  hasEnded: boolean
  emojiGridOpen: boolean
  activeReactions: ActiveReaction[]
  triggeredReactionIds: Record<string, true>
  lastReactionTime: number
  lastReactionPlaybackMs: number | null
}

export type VideoPlayerState$ = Observable<VideoPlayerState>

/** Wall-clock window for resuming a PiP dismissal pause when returning to the app. */
export const PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS = 1_000

export function shouldOwnPlaybackSession({
  isActive,
  isScreenFocused,
  shouldSuppressPlayback,
}: {
  isActive: boolean
  isScreenFocused: boolean
  shouldSuppressPlayback: boolean
}) {
  return isActive && isScreenFocused && !shouldSuppressPlayback
}

export function shouldLoadVideoSource({
  videoUrl,
  isActive,
  isScreenFocused,
  shouldSuppressPlayback,
}: {
  videoUrl: string | null
  isActive: boolean
  isScreenFocused: boolean
  shouldSuppressPlayback: boolean
}) {
  // Keep the source loaded while this item is the focused session, including
  // when the app is backgrounded, so Picture-in-Picture can keep playing.
  return (
    !!videoUrl && shouldOwnPlaybackSession({ isActive, isScreenFocused, shouldSuppressPlayback })
  )
}

export function pictureInPictureStopAction(appState: AppStateStatus) {
  return appState === 'active' ? 'keep-playing' : 'pause-then-maybe-resume'
}

export function shouldResumeAfterPictureInPictureStop({
  appState,
  elapsedMs,
  graceMs,
}: {
  appState: AppStateStatus
  elapsedMs: number
  graceMs: number
}) {
  return appState === 'active' && elapsedMs >= 0 && elapsedMs <= graceMs
}

export function shouldShowRespondCTA({
  hasEnded,
  isPlaying,
  isLoading,
}: Pick<VideoPlayerState, 'hasEnded' | 'isPlaying' | 'isLoading'>) {
  return hasEnded && !isPlaying && !isLoading
}

/** How close to the end counts as "finished" when deciding to replay. */
export const PLAYBACK_END_TOLERANCE_SECONDS = 0.25

export type PlayPauseAction = 'pause' | 'replay' | 'play'

/** Pause active playback first; only replay a stopped player with evidence of completion. */
export function resolvePlayPauseAction({
  isPlaying,
  isHolding,
  hasEnded,
  currentTime,
  duration,
}: {
  isPlaying: boolean
  isHolding: boolean
  hasEnded: boolean
  currentTime: number
  duration: number
}): PlayPauseAction {
  if (isPlaying || isHolding) return 'pause'
  // If native duration is unavailable (for example, a live playlist), trust playToEnd.
  const atEnd =
    Number.isFinite(duration) && duration > 0
      ? currentTime >= duration - PLAYBACK_END_TOLERANCE_SECONDS
      : true
  if (hasEnded && atEnd) return 'replay'
  return 'play'
}

type ReactionPlaybackMarker = {
  _id: string
  timestampMs: number
}

export function clearActiveReactions(state$: VideoPlayerState$) {
  if (state$.activeReactions.get().length === 0) return
  state$.activeReactions.set([])
}

export function resetReactionState(state$: VideoPlayerState$) {
  state$.activeReactions.set([])
  state$.triggeredReactionIds.set({})
  state$.lastReactionPlaybackMs.set(null)
  state$.lastReactionTime.set(0)
  state$.emojiGridOpen.set(false)
}

export function syncReactionPlaybackAfterSeek({
  positionMs,
  reactionsData,
  state$,
}: {
  positionMs: number
  reactionsData: readonly ReactionPlaybackMarker[] | undefined
  state$: VideoPlayerState$
}) {
  const safePositionMs = Math.max(0, positionMs)
  const triggeredReactionIds: Record<string, true> = {}
  for (const reaction of reactionsData ?? []) {
    if (reaction.timestampMs <= safePositionMs) {
      triggeredReactionIds[reaction._id] = true
    }
  }

  state$.lastReactionPlaybackMs.set(safePositionMs)
  state$.triggeredReactionIds.set(triggeredReactionIds)
  clearActiveReactions(state$)
}

/** Segmented EVENT playlists are playable by everyone, including their creator. */
export function suppressOwnerReplay(isLive: boolean, isSegmented: boolean, isOwner: boolean) {
  return isLive && !isSegmented && isOwner
}
