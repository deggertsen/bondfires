import { observable } from '@legendapp/state'
import { describe, expect, it } from 'vitest'
import {
  shouldLoadVideoSource,
  shouldOwnPlaybackSession,
  shouldPauseAfterPictureInPictureStop,
  shouldShowRespondCTA,
  syncReactionPlaybackAfterSeek,
  type VideoPlayerState,
} from '../../app/(main)/bondfire/_lib/videoPlayerState'
import type { ActiveReaction } from '../../components/ViewerPresenceStack'

function createVideoPlayerState() {
  return observable<VideoPlayerState>({
    showReport: false,
    progress: 0,
    duration: 0,
    captionText: '',
    isLoading: false,
    hasError: false,
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

  it('loads a video source only for the active focused player', () => {
    expect(
      shouldLoadVideoSource({
        videoUrl: 'https://stream.mux.com/test.m3u8',
        isActive: true,
        isScreenFocused: true,
        shouldSuppressPlayback: false,
      }),
    ).toBe(true)

    expect(
      shouldLoadVideoSource({
        videoUrl: 'https://stream.mux.com/test.m3u8',
        isActive: false,
        isScreenFocused: true,
        shouldSuppressPlayback: false,
      }),
    ).toBe(false)
  })

  it('keeps the source loaded when the app is backgrounded so PiP can continue', () => {
    const base = {
      videoUrl: 'https://stream.mux.com/test.m3u8',
      isActive: true,
      isScreenFocused: true,
      shouldSuppressPlayback: false,
    }

    expect(shouldLoadVideoSource(base)).toBe(true)
    expect(shouldLoadVideoSource({ ...base, isScreenFocused: false })).toBe(false)
    expect(shouldLoadVideoSource({ ...base, shouldSuppressPlayback: true })).toBe(false)
    expect(shouldLoadVideoSource({ ...base, videoUrl: null })).toBe(false)
  })

  it('gives the playback session only to the active focused viewer', () => {
    const base = {
      isActive: true,
      isScreenFocused: true,
      shouldSuppressPlayback: false,
    }

    expect(shouldOwnPlaybackSession(base)).toBe(true)
    expect(shouldOwnPlaybackSession({ ...base, isActive: false })).toBe(false)
    expect(shouldOwnPlaybackSession({ ...base, isScreenFocused: false })).toBe(false)
    expect(shouldOwnPlaybackSession({ ...base, shouldSuppressPlayback: true })).toBe(false)
  })

  it('pauses after PiP closes only when the app is still in the background', () => {
    expect(shouldPauseAfterPictureInPictureStop('background')).toBe(true)
    expect(shouldPauseAfterPictureInPictureStop('inactive')).toBe(true)
    expect(shouldPauseAfterPictureInPictureStop('unknown')).toBe(true)
    expect(shouldPauseAfterPictureInPictureStop('extension')).toBe(true)
    expect(shouldPauseAfterPictureInPictureStop('active')).toBe(false)
  })

  it('shows the response CTA only in the settled ended state', () => {
    expect(shouldShowRespondCTA({ hasEnded: true, isPlaying: false, isLoading: false })).toBe(true)
    expect(shouldShowRespondCTA({ hasEnded: false, isPlaying: false, isLoading: false })).toBe(
      false,
    )
    expect(shouldShowRespondCTA({ hasEnded: true, isPlaying: true, isLoading: false })).toBe(false)
    expect(shouldShowRespondCTA({ hasEnded: true, isPlaying: false, isLoading: true })).toBe(false)
  })
})
