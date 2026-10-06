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

/** One controller per player, video, live/VOD mode and explicit speed choice. */
export function createLiveEdgePlayback({
  isLive,
  preferredRate,
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
  canPace: () => boolean
  canResume: () => boolean
  setRate: (rate: number) => void
  pause: () => void
  resume: () => void
  onHoldingChange?: (isHolding: boolean) => void
  onAction?: (action: 'switch-to-realtime' | 'extend-buffer') => void
}) {
  let realtime = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  const applyRate = () => setRate(isLive && realtime ? LIVE_EDGE_FALLBACK_RATE : preferredRate)
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
  return {
    applyRate,
    cancel,
    isHolding: () => timer !== null,
    onStatus(status: string) {
      if (status === 'error') cancel()
      // Readiness is not playback: keep our deliberate pause until its deadline.
      // React to short buffering cycles too, not just the watchdog's 15s warning.
      if (status !== 'loading' || !isLive || !canPace() || timer !== null) return
      if (!realtime && preferredRate > LIVE_EDGE_FALLBACK_RATE) {
        realtime = true
        applyRate()
        onAction?.('switch-to-realtime')
        return
      }
      const pendingGeneration = ++generation
      timer = setTimeout(() => {
        if (pendingGeneration !== generation) return
        timer = null
        onHoldingChange?.(false)
        if (canResume()) resume()
      }, LIVE_EDGE_BUFFER_HOLD_MS)
      onHoldingChange?.(true)
      pause()
      onAction?.('extend-buffer')
    },
  }
}
