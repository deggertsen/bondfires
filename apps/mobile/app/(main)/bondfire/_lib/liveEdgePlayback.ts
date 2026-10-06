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

/**
 * Extra hold applied on top of a natural buffer stall while a live stream is
 * already at realtime, in milliseconds. Mux's live segments are a few seconds
 * long, so a few extra seconds is enough for the head to move past the
 * playhead and resume without an immediate second catch-up.
 */
export const LIVE_EDGE_BUFFER_HOLD_MS = 5_000

export type LiveEdgeStallAction = 'switch-to-realtime' | 'extend-buffer' | 'none'

/**
 * What to do when a live stream stalls while buffering. Non-live playback is
 * untouched — VOD stalls still go through reload-based recovery, which can
 * genuinely fetch the missing media.
 */
export function decideLiveEdgeStall(isLive: boolean, effectiveRate: number): LiveEdgeStallAction {
  if (!isLive) return 'none'
  return effectiveRate > LIVE_EDGE_FALLBACK_RATE ? 'switch-to-realtime' : 'extend-buffer'
}

/**
 * Playback rate to actually apply. The live-edge fallback outranks the user's
 * speed preference for the rest of the session; clearing the fallback (an
 * explicit speed change in settings) restores the preference.
 */
export function resolveEffectivePlaybackRate(
  isLive: boolean,
  isLiveEdgeRealtime: boolean,
  preferredRate: number,
) {
  return isLive && isLiveEdgeRealtime ? LIVE_EDGE_FALLBACK_RATE : preferredRate
}
