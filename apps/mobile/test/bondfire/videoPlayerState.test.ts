import { observable } from '@legendapp/state'
import { describe, expect, it } from 'vitest'
import {
  PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
  PLAYBACK_END_TOLERANCE_SECONDS,
  pictureInPictureStopAction,
  RESPOND_NUDGE_MIN_DURATION_MS,
  RESPOND_NUDGE_WINDOW_MS,
  resolvePlayPauseAction,
  shouldLoadVideoSource,
  shouldOwnPlaybackSession,
  shouldResumeAfterPictureInPictureStop,
  shouldShowRespondCTA,
  shouldShowRespondNudge,
  suppressOwnerReplay,
  syncReactionPlaybackAfterSeek,
  type VideoPlayerState,
} from '../../app/(main)/bondfire/_lib/videoPlayerState'
import type { ActiveReaction } from '../../components/ViewerPresenceStack'

function createVideoPlayerState() {
  return observable<VideoPlayerState>({
    showReport: false,
    progress: 0,
    duration: 0,
    elapsedMs: 0,
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

  it('keeps playing when PiP stops after the app is already active', () => {
    expect(pictureInPictureStopAction('active')).toBe('keep-playing')
  })

  it.each(['background', 'inactive', 'unknown', 'extension'] as const)(
    'pauses immediately when PiP stops while %s',
    (appState) => {
      expect(pictureInPictureStopAction(appState)).toBe('pause-then-maybe-resume')
    },
  )

  it.each([0, 500, PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS])(
    'resumes on return to active within the grace window (%i ms)',
    (elapsedMs) => {
      expect(
        shouldResumeAfterPictureInPictureStop({
          appState: 'active',
          elapsedMs,
          graceMs: PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
        }),
      ).toBe(true)
    },
  )

  it.each([PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS + 1, 60_000, -1])(
    'keeps the dismissal pause when returning outside the wall-clock window (%i ms)',
    (elapsedMs) => {
      expect(
        shouldResumeAfterPictureInPictureStop({
          appState: 'active',
          elapsedMs,
          graceMs: PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
        }),
      ).toBe(false)
    },
  )

  it.each(['background', 'inactive', 'unknown', 'extension'] as const)(
    'does not resume while %s even within the grace window',
    (appState) => {
      expect(
        shouldResumeAfterPictureInPictureStop({
          appState,
          elapsedMs: 500,
          graceMs: PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
        }),
      ).toBe(false)
    },
  )

  describe('shouldShowRespondCTA', () => {
    const stopped = {
      hasEnded: false,
      isPlaying: false,
      isLoading: false,
      hasError: false,
      hasProgress: true,
      isHoldingLiveEdge: false,
      advancesOnEnd: false,
    }

    it('shows when paused partway through or finished', () => {
      expect(shouldShowRespondCTA(stopped)).toBe(true)
      expect(shouldShowRespondCTA({ ...stopped, hasEnded: true })).toBe(true)
      expect(shouldShowRespondCTA({ ...stopped, hasEnded: true, hasProgress: false })).toBe(true)
    })

    it('stays hidden before the first frame plays', () => {
      expect(shouldShowRespondCTA({ ...stopped, hasProgress: false })).toBe(false)
    })

    it('skips the end of a video that advances, but not a pause on it', () => {
      expect(shouldShowRespondCTA({ ...stopped, hasEnded: true, advancesOnEnd: true })).toBe(false)
      expect(shouldShowRespondCTA({ ...stopped, advancesOnEnd: true })).toBe(true)
    })

    it('stays hidden while playing, loading, errored or holding the live edge', () => {
      expect(shouldShowRespondCTA({ ...stopped, isPlaying: true })).toBe(false)
      expect(shouldShowRespondCTA({ ...stopped, isLoading: true })).toBe(false)
      expect(shouldShowRespondCTA({ ...stopped, hasError: true })).toBe(false)
      expect(shouldShowRespondCTA({ ...stopped, isHoldingLiveEdge: true })).toBe(false)
    })
  })

  describe('shouldShowRespondNudge', () => {
    const ending = {
      isPlaying: true,
      hasEnded: false,
      duration: 60_000,
      elapsedMs: 60_000 - RESPOND_NUDGE_WINDOW_MS,
      isLive: false,
    }

    it('shows over the last few seconds of a playing video', () => {
      expect(shouldShowRespondNudge(ending)).toBe(true)
      expect(shouldShowRespondNudge({ ...ending, elapsedMs: 59_900 })).toBe(true)
    })

    it('stays hidden before the window and once the video ends', () => {
      expect(shouldShowRespondNudge({ ...ending, elapsedMs: 54_000 })).toBe(false)
      expect(shouldShowRespondNudge({ ...ending, elapsedMs: 60_000 })).toBe(false)
      expect(shouldShowRespondNudge({ ...ending, hasEnded: true })).toBe(false)
    })

    it('stays hidden while paused (the centered button takes over)', () => {
      expect(shouldShowRespondNudge({ ...ending, isPlaying: false })).toBe(false)
    })

    it('skips live, short and unknown-length videos', () => {
      expect(shouldShowRespondNudge({ ...ending, isLive: true })).toBe(false)
      expect(
        shouldShowRespondNudge({
          ...ending,
          duration: RESPOND_NUDGE_MIN_DURATION_MS - 1,
          elapsedMs: RESPOND_NUDGE_MIN_DURATION_MS - 1_000,
        }),
      ).toBe(false)
      expect(shouldShowRespondNudge({ ...ending, duration: 0, elapsedMs: 0 })).toBe(false)
      expect(shouldShowRespondNudge({ ...ending, duration: Number.NaN })).toBe(false)
    })
  })

  describe('resolvePlayPauseAction', () => {
    const base = {
      isPlaying: false,
      isHolding: false,
      hasEnded: false,
      currentTime: 5,
      duration: 60,
    }

    it('pauses a playing video even when a stale end flag is set', () => {
      // The reported bug: pressing pause on a playing video restarted it.
      expect(resolvePlayPauseAction({ ...base, isPlaying: true, hasEnded: true })).toBe('pause')
    })

    it('pauses a live-edge hold so the tap is not read as play', () => {
      expect(resolvePlayPauseAction({ ...base, isHolding: true })).toBe('pause')
    })

    it('replays only when the stopped player is actually at its end', () => {
      expect(
        resolvePlayPauseAction({
          ...base,
          hasEnded: true,
          currentTime: 60 - PLAYBACK_END_TOLERANCE_SECONDS,
        }),
      ).toBe('replay')
    })

    it('plays a mid-video player with an end flag that is stale', () => {
      expect(resolvePlayPauseAction({ ...base, hasEnded: true, currentTime: 12 })).toBe('play')
    })

    it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
      'trusts completion when native duration is unavailable (%s)',
      (duration) => {
        expect(resolvePlayPauseAction({ ...base, hasEnded: true, duration })).toBe('replay')
        expect(resolvePlayPauseAction({ ...base, duration })).toBe('play')
      },
    )

    it('plays a paused, not-yet-ended video', () => {
      expect(resolvePlayPauseAction(base)).toBe('play')
    })
  })
})

it('allows a creator to watch a growing segmented playlist while preserving legacy replay gating', () => {
  expect(suppressOwnerReplay(true, true, true)).toBe(false)
  expect(suppressOwnerReplay(true, false, true)).toBe(true)
  expect(suppressOwnerReplay(true, false, false)).toBe(false)
  expect(suppressOwnerReplay(false, false, true)).toBe(false)
  expect(
    shouldLoadVideoSource({
      videoUrl: 'https://media.test/index.m3u8',
      isActive: true,
      isScreenFocused: true,
      shouldSuppressPlayback: suppressOwnerReplay(true, true, true),
    }),
  ).toBe(true)
})
