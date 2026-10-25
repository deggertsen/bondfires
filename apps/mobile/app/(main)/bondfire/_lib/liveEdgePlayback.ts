/**
 * Live-edge playback policy.
 *
 * A viewer watching faster than realtime races the broadcaster's upload head:
 * the player drains the newest segment, stalls, the stream advances a few
 * seconds, it plays again — the play/buffer/play stutter. Reloading at the edge
 * cannot expose media that has not been uploaded yet, so recovery is pacing
 * rather than fetching:
 *
 *   1. faster than realtime -> drop to realtime so the playhead tracks the
 *      head instead of outrunning it;
 *   2. already realtime -> extend the buffer pause so the upload head can get
 *      ahead of the playhead.
 */

/** Speed a live stream is held at once it reaches the upload edge. */
export const LIVE_EDGE_FALLBACK_RATE = 1

/** Give the upload head five seconds to advance before consuming more media. */
export const LIVE_EDGE_BUFFER_HOLD_MS = 5_000

/** Rate state belongs to the watch, not a native player/controller instance. */
export function createWatchPlaybackRate(preferredRate: number) {
  let preference = preferredRate
  let rate = preferredRate
  let caughtHead = false
  return {
    getRate: () => rate,
    choose(next: number) {
      preference = next
      rate = next
    },
    syncPreference(next: number) {
      if (next !== preference) this.choose(next)
    },
    latch() {
      if (caughtHead) return false
      caughtHead = true
      if (rate <= LIVE_EDGE_FALLBACK_RATE) return false
      rate = LIVE_EDGE_FALLBACK_RATE
      return true
    },
  }
}

/** All native rate writes, including initialization, go through this funnel. */
export function applyWatchPlaybackRate(player: { playbackRate: number }, rate: number) {
  player.playbackRate = rate
}

export const LIVE_EDGE_SILENCE_MS = 1_500

/** One controller per native player; the watch rate survives replacement. */
export function createLiveEdgePlayback({
  isLive,
  preferredRate,
  watchRate = createWatchPlaybackRate(preferredRate),
  canPace,
  canResume,
  setRate,
  pause,
  resume,
  onHoldingChange,
  onAction,
}: {
  isLive: boolean
  preferredRate: number
  watchRate?: ReturnType<typeof createWatchPlaybackRate>
  canPace: () => boolean
  canResume: () => boolean
  setRate: (rate: number) => void
  pause: () => void
  resume: () => void
  onHoldingChange?: (isHolding: boolean) => void
  onAction?: (action: 'switch-to-realtime' | 'extend-buffer') => void
}) {
  let lastTimeUpdateAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  const applyRate = () => setRate(watchRate.getRate())
  // Only undo a pause owned by this controller. Callers can instead discard it
  // on pause, error, source replacement, timeout or unmount.
  const cancel = (resumeHeldPlayback = false) => {
    generation += 1
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    onHoldingChange?.(false)
    if (resumeHeldPlayback && canResume()) resume()
  }
  const onEdge = () => {
    if (!isLive || !canPace() || timer !== null) return
    if (watchRate.latch()) {
      applyRate()
      onAction?.('switch-to-realtime')
      return
    }
    const pendingGeneration = ++generation
    timer = setTimeout(() => {
      if (pendingGeneration !== generation) return
      timer = null
      lastTimeUpdateAt = Date.now()
      onHoldingChange?.(false)
      if (canResume()) resume()
    }, LIVE_EDGE_BUFFER_HOLD_MS)
    onHoldingChange?.(true)
    pause()
    onAction?.('extend-buffer')
  }
  return {
    applyRate,
    cancel,
    isHolding: () => timer !== null,
    onTimeUpdate() {
      lastTimeUpdateAt = Date.now()
    },
    checkForStall() {
      if (!isLive || !canPace() || timer !== null) {
        lastTimeUpdateAt = Date.now()
        return false
      }
      if (Date.now() - lastTimeUpdateAt < LIVE_EDGE_SILENCE_MS) return false
      lastTimeUpdateAt = Date.now()
      onEdge()
      return true
    },
    onStatus(status: string) {
      if (status === 'error') cancel()
      if (status === 'loading') onEdge()
    },
  }
}
