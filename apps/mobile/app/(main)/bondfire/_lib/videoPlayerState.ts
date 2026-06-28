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
  currentUrl: string | null
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
