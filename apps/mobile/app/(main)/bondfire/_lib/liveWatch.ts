/** Shared header geometry keeps presence below navigation on both platforms. */
export const PLAYBACK_HEADER_TOP_PADDING = 10
export const PLAYBACK_HEADER_HEIGHT = 40
export const PLAYBACK_HEADER_BOTTOM_PADDING = 12
export const PRESENCE_LABEL = 'here'
export function presenceTop(topInset: number) {
  return (
    topInset +
    PLAYBACK_HEADER_TOP_PADDING +
    PLAYBACK_HEADER_HEIGHT +
    PLAYBACK_HEADER_BOTTOM_PADDING +
    8
  )
}

export function liveWatchLabel(isLive: boolean, recordingStopped = false) {
  return isLive ? (recordingStopped ? 'PROCESSING' : 'LIVE') : null
}

const safeSeconds = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)
export function playbackClock(
  currentTime: number,
  duration: number,
  bufferedPosition: number,
  serverDuration = 0,
) {
  const elapsedMs = safeSeconds(currentTime) * 1000
  const totalMs = Math.max(
    elapsedMs,
    ...[duration, bufferedPosition, serverDuration]
      .map(safeSeconds)
      .map((seconds) => seconds * 1000),
  )
  return { elapsedMs, totalMs, progress: totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0 }
}
