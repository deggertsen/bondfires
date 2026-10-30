import { getFunctionName } from 'convex/server'
import { createElement, createRef, useMemo } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  VideoPlayer,
  type VideoPlayerHandle,
  type VideoPlayerProps,
} from '../../app/(main)/bondfire/_components/VideoPlayer'
import { LIVE_EDGE_BUFFER_HOLD_MS } from '../../app/(main)/bondfire/_lib/liveEdgePlayback'

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: never) => void>>(),
  play: vi.fn(),
  pause: vi.fn(),
  replay: vi.fn(),
  replaceAsync: vi.fn(),
  activateKeepAwake: vi.fn(),
  deactivateKeepAwake: vi.fn(),
  serverDuration: undefined as number | undefined,
  query: vi.fn(),
  reactions: [] as {
    _id: string
    userId: string
    emoji: string
    timestampMs: number
    createdAt: number
  }[],
}))

const { store, playback } = await vi.hoisted(async () => {
  const { observable } = await import('@legendapp/state')
  const store = observable({
    preferences: {
      autoplayVideos: true,
      playbackSpeed: 1,
      videoMuted: false,
      playbackQuality: 720,
    },
    userId: 'viewer',
  })
  const player = {
    playing: false,
    status: 'readyToPlay',
    currentTime: 10,
    duration: 60,
    playbackRate: 1,
    play: native.play,
    pause: native.pause,
    replay: native.replay,
    replaceAsync: native.replaceAsync,
    addListener: (name: string, listener: (event: never) => void) => {
      const listeners = native.listeners.get(name) ?? new Set()
      listeners.add(listener)
      native.listeners.set(name, listeners)
      return { remove: () => listeners.delete(listener) }
    },
  }
  return { store, playback: { player } }
})

vi.mock('@bondfires/app', () => ({
  appStore$: store,
  appActions: {},
  safelyUseCurrentPlayer: (
    active: unknown,
    captured: unknown,
    operation: (p: unknown) => unknown,
  ) => (active === captured ? operation(active) : undefined),
  telemetry: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setCrashBreadcrumb: vi.fn(),
    clearCrashBreadcrumb: vi.fn(),
  },
  tierMeetsRequirement: () => false,
  usePresence: () => ({ viewers: [] }),
  useSubscription: () => ({ currentTier: 'free' }),
}))
vi.mock('@bondfires/ui', () => ({ Spinner: 'Spinner', Text: 'Text' }))
vi.mock('tamagui', () => ({ YStack: 'YStack' }))
vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(),
  useQuery: (query: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(query)
    native.query(name, args)
    return name === 'segmentMedia:playbackDuration' && args !== 'skip'
      ? native.serverDuration
      : undefined
  },
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: native.activateKeepAwake,
  deactivateKeepAwake: native.deactivateKeepAwake,
}))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }))
vi.mock('expo-video', () => ({
  useVideoPlayer: (source: unknown, setup: (player: typeof playback.player) => void) => {
    // Expo recreates its native player when the serialized source (including metadata) changes.
    const sourceKey = JSON.stringify(source)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Match Expo: source changes recreate the player; setup identity does not.
    return useMemo(() => {
      const player = { ...playback.player, playing: false, currentTime: 0, duration: 60 }
      playback.player = player
      setup(player)
      return player
    }, [sourceKey])
  },
  VideoView: 'VideoView',
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  PanResponder: { create: (handlers: unknown) => ({ panHandlers: handlers }) },
  Pressable: 'Pressable',
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('../../lib/media/useOptionalQuery', () => ({
  useOptionalQuery: (query: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(query)
    native.query(name, args)
    return {
      data:
        name === 'videoReactions:getReactions' && args !== 'skip' ? native.reactions : undefined,
    }
  },
}))
vi.mock('../../app/(main)/bondfire/_lib/usePlaybackQuality', () => ({
  usePlaybackQuality: vi.fn(),
}))
// Keep the real player/controller wiring; expose overlay inputs as host props.
vi.mock('../../components/FloatingReactionsLayer', () => ({
  FloatingReactionsLayer: 'FloatingReactionsLayer',
}))
vi.mock('../../app/(main)/bondfire/_components/VideoPlayerOverlays', () => ({
  CaptionOverlay: 'CaptionOverlay',
  getFloatingReactionsAnchor: () => ({ bottom: 0, right: 0 }),
  HEATMAP_STRIP_HEIGHT: 44,
  LoadingOverlay: 'LoadingOverlay',
  PausedReportButton: 'PausedReportButton',
  PlaybackErrorOverlay: 'PlaybackErrorOverlay',
  PlayPauseIndicator: 'PlayPauseIndicator',
  ReactionPresenceLayer: 'ReactionPresenceLayer',
  ReportOverlayGate: 'ReportOverlayGate',
  RESPOND_NUDGE_HEIGHT: 60,
  RespondCTAOverlay: 'RespondCTAOverlay',
  RespondNudgeCard: 'RespondNudgeCard',
  RightSideControls: 'RightSideControls',
  VideoProgressBar: 'VideoProgressBar',
}))

describe('live-edge VideoPlayer integration', () => {
  let renderer: ReturnType<typeof create>
  const props: VideoPlayerProps = {
    bondfireId: 'fire' as Id<'bondfires'>,
    videoUrl: 'https://example.com/live.m3u8',
    videoOwnerId: 'creator' as Id<'users'>,
    isActive: true,
    isScreenFocused: true,
    isAppActive: true,
    isLive: true,
    isMainVideo: true,
    creatorName: 'Creator',
    onComplete: vi.fn(),
    onStart: vi.fn(),
    onProgress: vi.fn(),
  }
  const host = (name: string) => renderer.root.findByType(name)
  const emit = (name: string, event: unknown) => {
    for (const listener of native.listeners.get(name) ?? []) listener(event as never)
  }
  const status = async (value: string) => {
    await act(async () => {
      playback.player.status = value
      emit('statusChange', { status: value })
    })
  }
  const tick = async () => act(async () => vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS))

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    native.serverDuration = undefined
    native.reactions = []
    native.listeners.clear()
    store.preferences.autoplayVideos.set(true)
    store.preferences.playbackSpeed.set(1)
    playback.player.playing = false
    playback.player.status = 'readyToPlay'
    native.play.mockImplementation(() => {
      playback.player.playing = true
      emit('playingChange', { isPlaying: true })
    })
    native.replay.mockImplementation(() => {
      playback.player.currentTime = 0
      native.play()
    })
    native.pause.mockImplementation(() => {
      playback.player.playing = false
      emit('playingChange', { isPlaying: false })
    })
    native.replaceAsync.mockImplementation(async () => {
      playback.player.currentTime = 0
      playback.player.status = 'readyToPlay'
      emit('statusChange', { status: 'readyToPlay' })
    })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(createElement(VideoPlayer, props))
    })
    // Native playback begins after listeners are installed.
    await act(async () => native.play())
    native.play.mockClear()
  })

  afterEach(async () => {
    await act(async () => renderer?.unmount())
    vi.useRealTimers()
  })

  it('keeps a ready but held player buffering, awake and eligible for automatic PiP', async () => {
    native.deactivateKeepAwake.mockClear()
    await status('loading')
    await status('readyToPlay')
    expect(playback.player.playing).toBe(false)
    expect(host('LoadingOverlay').props.state$.isLoading.peek()).toBe(true)
    for (const overlay of ['LoadingOverlay', 'PlayPauseIndicator', 'PausedReportButton']) {
      expect(host(overlay).props.isHoldingLiveEdge).toBe(true)
    }
    expect(host('VideoView').props.startsPictureInPictureAutomatically).toBe(true)
    expect(native.activateKeepAwake).toHaveBeenCalled()
    expect(native.deactivateKeepAwake).not.toHaveBeenCalled()
    await tick()
    expect(native.play).toHaveBeenCalledOnce()
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(false)
  })

  it('treats a tap during a hold as a deliberate pause that survives the deadline', async () => {
    await status('loading')
    await status('readyToPlay')
    await act(async () => host('Pressable').props.onPress())
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(false)
    expect(host('VideoView').props.startsPictureInPictureAutomatically).toBe(false)
    await tick()
    expect(native.play).not.toHaveBeenCalled()
    expect(playback.player.playing).toBe(false)
    await act(async () => host('Pressable').props.onPress())
    expect(native.play).toHaveBeenCalledOnce()
  })

  it('clears a hold on an explicit speed change and resumes at the new preference', async () => {
    await status('loading')
    await status('readyToPlay')
    await act(async () => store.preferences.playbackSpeed.set(1.5))
    expect(playback.player.playbackRate).toBe(1.5)
    expect(playback.player.playing).toBe(true)
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(false)
    native.play.mockClear()
    await tick()
    expect(native.play).not.toHaveBeenCalled()
  })

  const finish = async () => {
    // Completion tests use a finished video; a live upload head is not the end.
    await act(async () => renderer.update(createElement(VideoPlayer, { ...props, isLive: false })))
    native.play.mockClear()
    native.pause.mockClear()
    await act(async () => {
      playback.player.currentTime = 60
      playback.player.playing = false
      emit('playToEnd', {})
    })
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(true)
  }

  it('pauses in place with a stale end flag, then resumes without replaying', async () => {
    await finish()
    // Native properties may advance before the corresponding JS event arrives.
    playback.player.currentTime = 12
    playback.player.playing = true
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(true)

    await act(async () => host('Pressable').props.onPress())
    expect(native.pause).toHaveBeenCalledOnce()
    expect(playback.player.playing).toBe(false)
    expect(playback.player.currentTime).toBe(12)
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)

    await act(async () => host('Pressable').props.onPress())
    expect(native.play).toHaveBeenCalledOnce()
    expect(playback.player.currentTime).toBe(12)
    expect(native.replay).not.toHaveBeenCalled()
  })

  it('clears completion when native playback resumes', async () => {
    await finish()
    playback.player.currentTime = 12
    await act(async () => native.play())
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)
  })

  it('clears stale completion on resume before a native event arrives', async () => {
    await finish()
    playback.player.currentTime = 12
    native.play.mockImplementationOnce(() => {
      playback.player.playing = true
    })
    await act(async () => host('Pressable').props.onPress())
    expect(native.play).toHaveBeenCalledOnce()
    expect(native.replay).not.toHaveBeenCalled()
    expect(playback.player.currentTime).toBe(12)
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)
  })

  it('replays from zero after genuine completion', async () => {
    await act(async () => renderer.update(createElement(VideoPlayer, { ...props, isLive: false })))
    await finish()
    await act(async () => host('Pressable').props.onPress())
    expect(native.replay).toHaveBeenCalledOnce()
    expect(playback.player.currentTime).toBe(0)
    expect(playback.player.playing).toBe(true)
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)
  })

  it.each([
    ['URL', { videoUrl: 'https://example.com/reissued.m3u8' }],
    ['metadata', { bondfireTitle: 'Updated title' }],
  ])('clears completion on a %s replacement with autoplay disabled', async (_, changedProps) => {
    await act(async () => store.preferences.autoplayVideos.set(false))
    await finish()
    const oldPlayer = playback.player
    await act(async () =>
      renderer.update(createElement(VideoPlayer, { ...props, ...changedProps })),
    )
    expect(playback.player).not.toBe(oldPlayer)
    expect(playback.player.currentTime).toBe(0)
    expect(playback.player.playing).toBe(false)
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)
    await act(async () => host('Pressable').props.onPress())
    expect(native.play).toHaveBeenCalledOnce()
    expect(native.replay).not.toHaveBeenCalled()
  })

  it('latches without loading, reports 1x, survives replacement, and honors an explicit same-speed choice', async () => {
    const onEffectiveRateChange = vi.fn()
    const ref = createRef<VideoPlayerHandle>()
    const watchProps = { ...props, ref, onEffectiveRateChange }
    await act(async () => {
      store.preferences.playbackSpeed.set(2)
      renderer.update(createElement(VideoPlayer, watchProps))
    })
    await act(async () => vi.advanceTimersByTime(1500))
    expect(playback.player.status).toBe('readyToPlay')
    expect(playback.player.playbackRate).toBe(1)
    expect(onEffectiveRateChange).toHaveBeenLastCalledWith('fire', 1)
    expect(store.preferences.playbackSpeed.peek()).toBe(2)
    const oldPlayer = playback.player
    await act(async () =>
      renderer.update(createElement(VideoPlayer, { ...watchProps, bondfireTitle: 'New metadata' })),
    )
    expect(playback.player).not.toBe(oldPlayer)
    expect(playback.player.playbackRate).toBe(1)
    await act(async () => ref.current?.choosePlaybackSpeed(2))
    expect(playback.player.playbackRate).toBe(2)
    expect(onEffectiveRateChange).toHaveBeenLastCalledWith('fire', 2)
    await act(async () =>
      renderer.update(
        createElement(VideoPlayer, { ...watchProps, bondfireId: 'next' as Id<'bondfires'> }),
      ),
    )
    expect(playback.player.playbackRate).toBe(2)
  })

  it('detects a frozen playhead despite periodic native time events', async () => {
    await act(async () => store.preferences.playbackSpeed.set(2))
    await act(async () => emit('timeUpdate', { currentTime: 10 }))
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(250)
        emit('timeUpdate', { currentTime: 10 })
      })
    }
    expect(playback.player.playbackRate).toBe(1)
    expect(host('LoadingOverlay').props.state$.isLoading.peek()).toBe(true)
    expect(native.replaceAsync).not.toHaveBeenCalled()
    await act(async () => emit('timeUpdate', { currentTime: 10.25 }))
    expect(host('LoadingOverlay').props.state$.isLoading.peek()).toBe(false)
  })

  it('times out a live stall despite ready events and stationary ticks, then retries in place', async () => {
    await act(async () => emit('timeUpdate', { currentTime: 10 }))
    await status('loading')
    for (let i = 0; i < 15; i++) {
      await status('readyToPlay')
      await act(async () => {
        vi.advanceTimersByTime(5000)
        emit('timeUpdate', { currentTime: 10 })
      })
    }
    expect(host('PlaybackErrorOverlay').props.state$.hasError.peek()).toBe(true)
    await act(async () => host('PlaybackErrorOverlay').props.onRetry())
    expect(host('PlaybackErrorOverlay').props.state$.hasError.peek()).toBe(false)
    expect(playback.player.playing).toBe(true)
    expect(native.replaceAsync).not.toHaveBeenCalled()
  })

  it('recovers fatal live errors with bounded reloads and a usable manual retry', async () => {
    await act(async () => store.preferences.playbackSpeed.set(2))
    await status('loading')
    expect(playback.player.playbackRate).toBe(1)
    playback.player.currentTime = 23
    for (const delay of [2000, 4000]) {
      await status('error')
      await act(async () => vi.advanceTimersByTime(delay))
      expect(playback.player.currentTime).toBe(23)
      expect(playback.player.playing).toBe(true)
    }
    expect(native.replaceAsync).toHaveBeenCalledTimes(2)
    await status('error')
    expect(host('PlaybackErrorOverlay').props.state$.hasError.peek()).toBe(true)
    await act(async () => host('PlaybackErrorOverlay').props.onRetry())
    expect(native.replaceAsync).toHaveBeenCalledTimes(3)
    expect(playback.player.currentTime).toBe(23)
    expect(playback.player.playbackRate).toBe(1)
    expect(playback.player.playing).toBe(true)
  })

  it('updates the clock from receipts while stalled and subscribes only for the active video', async () => {
    const watchProps = { ...props, segmentRecordingId: 'recording' as Id<'segmentRecordings'> }
    native.serverDuration = 64
    await act(async () => renderer.update(createElement(VideoPlayer, watchProps)))
    await act(async () => {
      vi.advanceTimersByTime(300)
      playback.player.currentTime = 62
      emit('timeUpdate', { currentTime: 62 })
    })
    const state = host('VideoProgressBar').props.state$
    expect(state.elapsedMs.peek()).toBe(62000)
    expect(state.duration.peek()).toBe(64000)
    native.serverDuration = 72
    await act(async () => renderer.update(createElement(VideoPlayer, watchProps)))
    expect(state.duration.peek()).toBe(72000)
    expect(state.elapsedMs.peek()).toBe(62000)
    native.query.mockClear()
    await act(async () =>
      renderer.update(createElement(VideoPlayer, { ...watchProps, isActive: false })),
    )
    expect(native.query).toHaveBeenCalledWith('segmentMedia:playbackDuration', 'skip')
  })

  it('seeks on the displayed timeline while staying inside the native duration', async () => {
    native.serverDuration = 120
    await act(async () =>
      renderer.update(
        createElement(VideoPlayer, {
          ...props,
          segmentRecordingId: 'recording' as Id<'segmentRecordings'>,
        }),
      ),
    )
    const bar = host('VideoProgressBar').props
    bar.progressBarViewRef.current = {
      measure: (callback: (...values: number[]) => void) => callback(0, 0, 400, 20, 0),
    }
    await act(async () => bar.onLayout({ nativeEvent: { layout: { width: 400 } } }))
    await act(async () => bar.panHandlers.onPanResponderGrant({ nativeEvent: { pageX: 100 } }))
    expect(playback.player.currentTime).toBe(30)
    expect(bar.state$.elapsedMs.peek()).toBe(30000)
    expect(bar.state$.progress.peek()).toBe(0.25)
    await act(async () => bar.panHandlers.onPanResponderRelease({}, { moveX: 400 }))
    expect(playback.player.currentTime).toBe(60)
    expect(bar.state$.elapsedMs.peek()).toBe(60000)
    expect(bar.state$.progress.peek()).toBe(0.5)
  })

  it('subscribes to live reactions and replays only the seek window when joining mid-recording', async () => {
    native.reactions = [
      { _id: 'old', userId: 'other', emoji: '🔥', timestampMs: 1000, createdAt: 1 },
      { _id: 'near', userId: 'other', emoji: '❤️', timestampMs: 39950, createdAt: 2 },
      { _id: 'next', userId: 'other', emoji: '🙏', timestampMs: 40050, createdAt: 3 },
    ]
    await act(async () => renderer.update(createElement(VideoPlayer, props)))
    expect(native.query).toHaveBeenCalledWith('videoReactions:getReactions', { bondfireId: 'fire' })
    await act(async () => emit('timeUpdate', { currentTime: 40 }))
    const state = host('ReactionPresenceLayer').props.state$
    expect(
      state.activeReactions.peek().map((reaction: { emoji: string }) => reaction.emoji),
    ).toEqual(['❤️'])
    await act(async () => emit('timeUpdate', { currentTime: 40.1 }))
    expect(
      state.activeReactions.peek().map((reaction: { emoji: string }) => reaction.emoji),
    ).toEqual(['❤️', '🙏'])
  })

  it('treats a live playToEnd as the upload head, not completed playback', async () => {
    await act(async () => emit('playToEnd', {}))
    expect(host('PlayPauseIndicator').props.state$.hasEnded.peek()).toBe(false)
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(true)
  })

  it('cancels a hold when the player loses focus', async () => {
    await status('loading')
    await act(async () =>
      renderer.update(createElement(VideoPlayer, { ...props, isScreenFocused: false })),
    )
    await tick()
    expect(native.play).not.toHaveBeenCalled()
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(false)
  })
})
