import { observable } from '@legendapp/state'
import { describe, expect, it } from 'vitest'
import type { ActiveReaction } from '../../components/ViewerPresenceStack'
import {
  syncReactionPlaybackAfterSeek,
  type VideoPlayerState,
} from '../../app/(main)/bondfire/_lib/videoPlayerState'

function createVideoPlayerState() {
  return observable<VideoPlayerState>({
    showReport: false,
    currentUrl: null,
    progress: 0,
    duration: 0,
    isLoading: false,
    isPlaying: false,
    userInitiatedPlay: false,
    hasEnded: false,
    emojiGridOpen: false,
    activeReactions: [
      {
        id: 'active-1',
        userId: 'user-1',
        userName: 'Ada',
        emoji: '🔥',
        timestampMs: 800,
        createdAt: 100,
      } satisfies ActiveReaction,
    ],
    triggeredReactionIds: {},
    lastReactionTime: 0,
    lastReactionPlaybackMs: null,
  })
}

describe('videoPlayerState', () => {
  it('marks reactions at or before the seek position as already triggered', () => {
    const state$ = createVideoPlayerState()

    syncReactionPlaybackAfterSeek({
      positionMs: 1000,
      reactionsData: [
        { _id: 'reaction-before', timestampMs: 999 },
        { _id: 'reaction-at-position', timestampMs: 1000 },
        { _id: 'reaction-after', timestampMs: 1001 },
      ],
      state$,
    })

    expect(state$.lastReactionPlaybackMs.get()).toBe(1000)
    expect(state$.triggeredReactionIds.get()).toEqual({
      'reaction-before': true,
      'reaction-at-position': true,
    })
    expect(state$.activeReactions.get()).toEqual([])
  })

  it('clamps negative seek positions before syncing reaction playback', () => {
    const state$ = createVideoPlayerState()

    syncReactionPlaybackAfterSeek({
      positionMs: -50,
      reactionsData: [{ _id: 'reaction-at-start', timestampMs: 0 }],
      state$,
    })

    expect(state$.lastReactionPlaybackMs.get()).toBe(0)
    expect(state$.triggeredReactionIds.get()).toEqual({ 'reaction-at-start': true })
  })
})
