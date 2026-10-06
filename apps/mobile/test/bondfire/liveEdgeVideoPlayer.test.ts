import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  VideoPlayer,
  type VideoPlayerProps,
} from '../../app/(main)/bondfire/_components/VideoPlayer'
import { LIVE_EDGE_BUFFER_HOLD_MS } from '../../app/(main)/bondfire/_lib/liveEdgePlayback'

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: never) => void>>(),
  play: vi.fn(),
  pause: vi.fn(),
  activateKeepAwake: vi.fn(),
  deactivateKeepAwake: vi.fn(),
}))

const { store, player } = await vi.hoisted(async () => {
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
    addListener: (name: string, listener: (event: never) => void) => {
      const listeners = native.listeners.get(name) ?? new Set()
      listeners.add(listener)
      native.listeners.set(name, listeners)
      return { remove: () => listeners.delete(listener) }
    },
  }
  return { store, player }
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
vi.mock('convex/react', () => ({ useMutation: () => vi.fn(), useQuery: () => undefined }))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: native.activateKeepAwake,
  deactivateKeepAwake: native.deactivateKeepAwake,
}))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }))
vi.mock('expo-video', () => ({ useVideoPlayer: () => player, VideoView: 'VideoView' }))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Pressable: 'Pressable',
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('../../lib/media/useOptionalQuery', () => ({ useOptionalQuery: () => ({}) }))
vi.mock('../../app/(main)/bondfire/_lib/usePlaybackQuality', () => ({
  usePlaybackQuality: vi.fn(),
}))
// Keep the real player/controller wiring; expose overlay inputs as host props.
vi.mock('../../app/(main)/bondfire/_components/VideoPlayerOverlays', () => ({
  CaptionOverlay: 'CaptionOverlay',
  LoadingOverlay: 'LoadingOverlay',
  PausedReportButton: 'PausedReportButton',
  PlaybackErrorOverlay: 'PlaybackErrorOverlay',
  PlayPauseIndicator: 'PlayPauseIndicator',
  ReactionPresenceLayer: 'ReactionPresenceLayer',
  ReportOverlayGate: 'ReportOverlayGate',
  RespondCTAOverlay: 'RespondCTAOverlay',
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
      player.status = value
      emit('statusChange', { status: value })
    })
  }
  const tick = async () => act(async () => vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS))

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    native.listeners.clear()
    store.preferences.playbackSpeed.set(1)
    player.playing = false
    player.status = 'readyToPlay'
    native.play.mockImplementation(() => {
      player.playing = true
      emit('playingChange', { isPlaying: true })
    })
    native.pause.mockImplementation(() => {
      player.playing = false
      emit('playingChange', { isPlaying: false })
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
    expect(player.playing).toBe(false)
    expect(host('LoadingOverlay').props.state$.isLoading.peek()).toBe(false)
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
    expect(player.playing).toBe(false)
    await act(async () => host('Pressable').props.onPress())
    expect(native.play).toHaveBeenCalledOnce()
  })

  it('clears a hold on an explicit speed change and resumes at the new preference', async () => {
    await status('loading')
    await status('readyToPlay')
    await act(async () => store.preferences.playbackSpeed.set(1.5))
    expect(player.playbackRate).toBe(1.5)
    expect(player.playing).toBe(true)
    expect(host('LoadingOverlay').props.isHoldingLiveEdge).toBe(false)
    native.play.mockClear()
    await tick()
    expect(native.play).not.toHaveBeenCalled()
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
