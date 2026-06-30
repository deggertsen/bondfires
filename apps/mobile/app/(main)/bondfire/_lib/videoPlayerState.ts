import type { Observable } from '@legendapp/state'
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
  isLoading: boolean
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

export function shouldLoadVideoSource({
  videoUrl,
  isActive,
  isScreenFocused,
  isAppActive,
  shouldSuppressPlayback,
}: {
  videoUrl: string | null
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  shouldSuppressPlayback: boolean
}) {
  return !!videoUrl && isActive && isScreenFocused && isAppActive && !shouldSuppressPlayback
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
