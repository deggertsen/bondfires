import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLiveEdgePlayback,
  LIVE_EDGE_BUFFER_HOLD_MS,
} from '../../app/(main)/bondfire/_lib/liveEdgePlayback'
import { createPictureInPicturePlayback } from '../../app/(main)/bondfire/_lib/pictureInPicturePlayback'
import { createStallWatchdog } from '../../app/(main)/bondfire/_lib/videoStallRecovery'

function fixture(preferredRate = 2, isLive = true) {
  vi.useFakeTimers()
  const gates = { started: true, foreground: true, canResume: true }
  const player = { rate: preferredRate, playing: true }
  const resume = vi.fn(() => {
    player.playing = true
  })
  const pause = vi.fn(() => {
    player.playing = false
  })
  const controller = createLiveEdgePlayback({
    isLive,
    preferredRate,
    canPace: () => gates.started && gates.foreground && gates.canResume,
    canResume: () => gates.canResume,
    setRate: (rate) => {
      player.rate = rate
    },
    pause,
    resume,
  })
  return { controller, gates, player, resume, pause }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('live-edge playback lifecycle', () => {
  it('paces brief 2x stalls, keeps 1x on reapplication, then holds a subsequent stall', () => {
    const { controller, player, resume } = fixture()
    controller.onStatus('loading')
    expect(player.rate).toBe(1)
    expect(controller.isHolding()).toBe(false)
    vi.advanceTimersByTime(200)
    controller.onStatus('readyToPlay')
    controller.applyRate()
    expect(player.rate).toBe(1)
    controller.onStatus('loading')
    expect(player.playing).toBe(false)
    vi.advanceTimersByTime(200)
    controller.onStatus('readyToPlay')
    expect(controller.isHolding()).toBe(true)
    expect(player.playing).toBe(false)
    vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS - 201)
    expect(resume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(resume).toHaveBeenCalledOnce()
    expect(player.playing).toBe(true)
    expect(player.rate).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 0.5])('holds at %sx without speeding up a slower preference', (speed) => {
    const { controller, player } = fixture(speed)
    controller.onStatus('loading')
    controller.applyRate()
    expect(player.rate).toBe(speed)
    expect(controller.isHolding()).toBe(true)
  })

  it('does not extend the deadline or leak timers on duplicate loading events', () => {
    const { controller, resume, pause } = fixture(1)
    controller.onStatus('loading')
    vi.advanceTimersByTime(4_000)
    controller.onStatus('loading')
    expect(pause).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('does not pace VOD, initial loads, deliberate pauses or background stalls', () => {
    const vod = fixture(2, false)
    vod.controller.onStatus('loading')
    expect(vod.player.rate).toBe(2)
    expect(vod.pause).not.toHaveBeenCalled()
    const live = fixture()
    for (const gate of ['started', 'foreground', 'canResume'] as const) {
      live.gates[gate] = false
      live.controller.onStatus('loading')
      expect(live.player.rate).toBe(2)
      expect(live.pause).not.toHaveBeenCalled()
      live.gates[gate] = true
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads current resume eligibility when the timer fires', () => {
    const { controller, gates, resume } = fixture(1)
    controller.onStatus('loading')
    gates.canResume = false
    vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS)
    expect(resume).not.toHaveBeenCalled()
    expect(controller.isHolding()).toBe(false)
  })

  it('discards holds on cancellation and errors, even if eligibility returns', () => {
    const { controller, resume } = fixture(1)
    controller.onStatus('loading')
    controller.cancel()
    expect(vi.getTimerCount()).toBe(0)
    controller.onStatus('loading')
    controller.onStatus('error')
    controller.onStatus('readyToPlay')
    vi.advanceTimersByTime(90_000)
    expect(resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an already-queued stale callback without clearing a newer hold', () => {
    const { controller, resume } = fixture(1)
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    controller.onStatus('loading')
    const staleCallback = scheduled.mock.calls[0][0] as () => void
    controller.cancel()
    controller.onStatus('loading')
    staleCallback()
    expect(controller.isHolding()).toBe(true)
    expect(resume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('undoes only its own pause for background/PiP or scrubbing handoff', () => {
    const { controller, gates, resume } = fixture(1)
    controller.cancel(true)
    expect(resume).not.toHaveBeenCalled()
    controller.onStatus('loading')
    gates.foreground = false
    controller.cancel(true)
    expect(resume).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(90_000)
    expect(resume).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never resumes a cancelled hold over a user pause or lost ownership', () => {
    const { controller, gates, resume } = fixture(1)
    controller.onStatus('loading')
    gates.canResume = false
    controller.cancel(true)
    gates.canResume = true
    vi.advanceTimersByTime(90_000)
    expect(resume).not.toHaveBeenCalled()
  })

  it('preserves PiP return intent when dismissal happens during an owned hold', () => {
    const { controller, player, pause, resume } = fixture(1)
    const pip = createPictureInPicturePlayback({
      getPlayback: () => ({
        isPlaying: player.playing || controller.isHolding(),
        canResume: true,
      }),
      pause: () => {
        controller.cancel()
        pause()
      },
      resume,
    })
    controller.onStatus('loading')
    pip.stop('background')
    expect(controller.isHolding()).toBe(false)
    vi.advanceTimersByTime(100)
    pip.onAppStateChange('active')
    expect(resume).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('new speed choices and player sessions start with their preferred rate', () => {
    const old = fixture()
    old.controller.onStatus('loading')
    old.controller.onStatus('loading')
    old.controller.cancel()
    const next = fixture(1.5)
    next.controller.applyRate()
    expect(next.player.rate).toBe(1.5)
    vi.advanceTimersByTime(90_000)
    expect(old.resume).not.toHaveBeenCalled()
    next.controller.onStatus('loading')
    expect(next.player.rate).toBe(1)
  })

  it('leaves the watchdog at 75s for continuous live loading without reloads', () => {
    const { controller, gates, resume } = fixture(1)
    const onRecover = vi.fn()
    const onGiveUp = vi.fn(() => {
      gates.canResume = false
      controller.cancel()
    })
    const watchdog = createStallWatchdog({
      isLive: true,
      canRun: () => gates.canResume,
      onWarn: vi.fn(),
      onRecover,
      onGiveUp,
    })
    watchdog.restart()
    controller.onStatus('loading')
    vi.advanceTimersByTime(74_999)
    expect(resume).toHaveBeenCalledOnce()
    expect(onGiveUp).not.toHaveBeenCalled()
    controller.onStatus('loading')
    expect(controller.isHolding()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(onGiveUp).toHaveBeenCalledOnce()
    expect(onRecover).not.toHaveBeenCalled()
    expect(controller.isHolding()).toBe(false)
    vi.advanceTimersByTime(LIVE_EDGE_BUFFER_HOLD_MS)
    expect(resume).toHaveBeenCalledOnce()
    watchdog.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
