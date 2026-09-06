import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createStallWatchdog,
  reloadVideoAtPosition,
} from '../../app/(main)/bondfire/_lib/videoStallRecovery'

describe('position-preserving stall recovery', () => {
  it('keeps the source metadata and seeks to the saved position before playing', async () => {
    const source = { uri: 'signed-url', metadata: { title: 'A fire' } }
    const order: string[] = []
    const player = {
      currentTime: 180.9,
      pause: () => order.push('pause'),
      replaceAsync: vi.fn(async () => {
        player.currentTime = 0
        order.push('replace')
      }),
      play: () => {
        expect(player.currentTime).toBe(180.9)
        order.push('play')
      },
    }
    await reloadVideoAtPosition({ player, source, isCurrent: () => true, shouldResume: () => true })
    expect(player.replaceAsync).toHaveBeenCalledWith(source)
    expect(order).toEqual(['pause', 'replace', 'play'])
  })

  it.each(['pause', 'swipe', 'retry', 'timeout', 'unmount'])(
    'does not resume a stale recovery after %s',
    async (reason) => {
      let resolve: () => void = () => {}
      let current = true
      let intent = true
      const player = {
        currentTime: 10,
        pause: vi.fn(),
        play: vi.fn(),
        replaceAsync: () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      }
      const pending = reloadVideoAtPosition({
        player,
        source: 'url',
        isCurrent: () => current,
        shouldResume: () => intent,
      })
      player.currentTime = 0
      if (reason === 'pause') intent = false
      else current = false
      resolve()
      await pending
      expect(player.play).not.toHaveBeenCalled()
      expect(player.currentTime).toBe(reason === 'pause' ? 10 : 0)
    },
  )

  it('never accesses a player that has already been released', async () => {
    const player = {
      get currentTime(): number {
        throw new Error('released')
      },
      pause: vi.fn(),
      play: vi.fn(),
      replaceAsync: vi.fn(),
    }
    await reloadVideoAtPosition({
      player,
      source: 'url',
      isCurrent: () => false,
      shouldResume: () => true,
    })
    expect(player.replaceAsync).not.toHaveBeenCalled()
  })

  it('leaves a rejected replacement to the error/watchdog paths without playing', async () => {
    const player = {
      currentTime: 3,
      pause: vi.fn(),
      play: vi.fn(),
      replaceAsync: vi.fn(async () => {
        throw new Error('offline')
      }),
    }
    await expect(
      reloadVideoAtPosition({
        player,
        source: 'url',
        isCurrent: () => true,
        shouldResume: () => true,
      }),
    ).rejects.toThrow('offline')
    expect(player.play).not.toHaveBeenCalled()
  })
})

describe('foreground stall watchdog', () => {
  afterEach(() => vi.useRealTimers())
  const fixture = (isLive = false) => {
    vi.useFakeTimers()
    let active = true
    const onWarn = vi.fn(),
      onRecover = vi.fn(),
      onGiveUp = vi.fn()
    const watchdog = createStallWatchdog({
      isLive,
      canRun: () => active,
      onWarn,
      onRecover,
      onGiveUp,
    })
    return {
      ...watchdog,
      onWarn,
      onRecover,
      onGiveUp,
      setActive: (value: boolean) => {
        active = value
      },
    }
  }
  it('warns at 15s, recovers once at 30s, and gives up at 45s', () => {
    const w = fixture()
    w.restart()
    vi.advanceTimersByTime(15_000)
    expect(w.onWarn).toHaveBeenCalledOnce()
    expect(w.onRecover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(15_000)
    expect(w.onRecover).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(15_000)
    expect(w.onGiveUp).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(90_000)
    expect(w.onRecover).toHaveBeenCalledOnce()
  })
  it('resets the clock across background/PiP suspension without interrupting playback', () => {
    const w = fixture()
    w.restart()
    vi.advanceTimersByTime(29_000)
    w.setActive(false)
    w.restart()
    vi.advanceTimersByTime(300_000)
    expect(w.onRecover).not.toHaveBeenCalled()
    expect(w.onGiveUp).not.toHaveBeenCalled()
    w.setActive(true)
    w.restart()
    vi.advanceTimersByTime(29_999)
    expect(w.onRecover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.onRecover).toHaveBeenCalledOnce()
  })
  it('checks current pause/focus/loading gates again when a timer fires', () => {
    const w = fixture()
    w.restart()
    w.setActive(false)
    vi.advanceTimersByTime(90_000)
    expect(w.onWarn).not.toHaveBeenCalled()
    expect(w.onRecover).not.toHaveBeenCalled()
    expect(w.onGiveUp).not.toHaveBeenCalled()
  })
  it('never reloads live streams and retains their 75s give-up window', () => {
    const w = fixture(true)
    w.restart()
    vi.advanceTimersByTime(74_999)
    expect(w.onRecover).not.toHaveBeenCalled()
    expect(w.onGiveUp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.onGiveUp).toHaveBeenCalledOnce()
  })
  it('cancels all pending callbacks on cleanup', () => {
    const w = fixture()
    w.restart()
    w.stop()
    vi.advanceTimersByTime(90_000)
    expect(w.onWarn).not.toHaveBeenCalled()
    expect(w.onRecover).not.toHaveBeenCalled()
    expect(w.onGiveUp).not.toHaveBeenCalled()
  })
})
