import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPictureInPicturePlayback } from '../../app/(main)/bondfire/_lib/pictureInPicturePlayback'

function setup() {
  const playback = { isPlaying: true, canResume: true }
  const getPlayback = vi.fn((): typeof playback | undefined => playback)
  const pause = vi.fn(() => {
    playback.isPlaying = false
  })
  const resume = vi.fn(() => {
    playback.isPlaying = true
  })
  return {
    playback,
    getPlayback,
    pause,
    resume,
    pip: createPictureInPicturePlayback({ getPlayback, pause, resume }),
  }
}

describe('PiP playback lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })
  afterEach(() => vi.useRealTimers())

  it('pauses synchronously without scheduling a background timer', () => {
    const { pip, pause, resume } = setup()
    pip.stop('background')
    expect(pause).toHaveBeenCalledExactlyOnceWith('background')
    expect(resume).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not change playback when foregrounding arrives before PiP stop', () => {
    const { pip, pause, resume } = setup()
    pip.onAppStateChange('active')
    pip.stop('active')
    expect(pause).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it.each([0, 500, 1_000])('resumes once after a prompt foreground return (%i ms)', (elapsed) => {
    const { pip, resume } = setup()
    pip.stop('inactive')
    pip.onAppStateChange('background')
    vi.setSystemTime(10_000 + elapsed)
    pip.onAppStateChange('inactive')
    expect(resume).not.toHaveBeenCalled()
    pip.onAppStateChange('active')
    pip.onAppStateChange('active')
    expect(resume).toHaveBeenCalledExactlyOnceWith(elapsed)
  })

  it.each([1_001, 60_000, -1])('keeps playback paused outside the window (%i ms)', (elapsed) => {
    const { pip, resume } = setup()
    pip.stop('background')
    // Simulate suspended JS: move wall time without running any timers.
    vi.setSystemTime(10_000 + elapsed)
    pip.onAppStateChange('active')
    vi.setSystemTime(10_500)
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })

  it('expires the return window on a late intermediate state', () => {
    const { pip, resume } = setup()
    pip.stop('background')
    vi.setSystemTime(11_001)
    pip.onAppStateChange('inactive')
    vi.setSystemTime(10_500)
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })

  it('preserves a pause made through the system PiP controls', () => {
    const { pip, playback, pause, resume } = setup()
    playback.isPlaying = false
    pip.stop('background')
    pip.onAppStateChange('active')
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not arm a return when playback is already ineligible', () => {
    const { pip, playback, resume } = setup()
    playback.canResume = false
    pip.stop('background')
    playback.canResume = true
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })

  it('rechecks playback eligibility on return and consumes a blocked return', () => {
    const { pip, playback, resume } = setup()
    pip.stop('background')
    // Completion, an error, scrubbing, or lost ownership must block resumption.
    playback.canResume = false
    pip.onAppStateChange('active')
    playback.canResume = true
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })

  it('allows controls, PiP restart, or session cleanup to cancel a pending return', () => {
    const { pip, resume } = setup()
    pip.stop('background')
    pip.cancel()
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })

  it('starts a fresh return window after cancellation and new playback', () => {
    const { pip, playback, resume } = setup()
    pip.stop('background')
    pip.cancel()
    vi.setSystemTime(20_000)
    playback.isPlaying = true
    pip.stop('background')
    vi.setSystemTime(20_500)
    pip.onAppStateChange('active')
    expect(resume).toHaveBeenCalledExactlyOnceWith(500)
  })

  it('ignores stop and foreground callbacks for released players', () => {
    const { pip, getPlayback, pause, resume } = setup()
    getPlayback.mockReturnValue(undefined)
    pip.stop('background')
    pip.onAppStateChange('active')
    expect(pause).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not resume a player released after PiP stop', () => {
    const { pip, getPlayback, resume } = setup()
    pip.stop('background')
    getPlayback.mockReturnValue(undefined)
    pip.onAppStateChange('active')
    expect(resume).not.toHaveBeenCalled()
  })
})
