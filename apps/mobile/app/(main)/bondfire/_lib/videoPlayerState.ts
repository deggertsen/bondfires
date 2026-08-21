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

/** Delay before pausing after PiP closes, so returning to the app is not treated as a dismiss. */
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

export function shouldPauseAfterPictureInPictureStop(appState: AppStateStatus) {
  return appState !== 'active'
}

export function shouldShowRespondCTA({
  hasEnded,
  isPlaying,
  isLoading,
}: Pick<VideoPlayerState, 'hasEnded' | 'isPlaying' | 'isLoading'>) {
  return hasEnded && !isPlaying && !isLoading
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
