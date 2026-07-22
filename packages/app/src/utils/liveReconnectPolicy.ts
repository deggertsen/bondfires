import type { LivePublishStatus } from '../store/livePublish.store'
import type { RecordingPhase } from '../store/recording.store'

/**
 * In-place RTMP reconnect after a mid-recording network change.
 *
 * Mux holds a dropped live stream resumable for the reconnect window returned
 * by createLiveStream. The client re-opens the socket against the same stream
 * key and the recording continues as one asset (viewers see a brief slate /
 * gap). The loop must give up BEFORE the window closes: once Mux finalizes,
 * a late reconnect would be rejected and the finalize fallback would race the
 * asset webhooks.
 */

/** Stop retrying this long before Mux's window expires. */
export const RECONNECT_SAFETY_MARGIN_MS = 10_000

/** Ceiling between attempts once backoff has ramped. */
const MAX_ATTEMPT_DELAY_MS = 8_000

/**
 * Deadline (epoch ms) for the whole reconnect flow. Zero/negative budget
 * means reconnect is effectively disabled — callers should skip the loop.
 */
export function computeReconnectDeadlineMs(reconnectWindowSeconds: number, now: number): number {
  const budgetMs = reconnectWindowSeconds * 1000 - RECONNECT_SAFETY_MARGIN_MS
  return now + Math.max(0, budgetMs)
}

/**
 * Delay before attempt N (0-based). The first retry is fast — most transport
 * switches settle in ~1-2s — then backs off so a dead network isn't hammered.
 */
export function getReconnectAttemptDelayMs(attempt: number): number {
  const ladder = [1_000, 3_000, 5_000]
  return ladder[attempt] ?? MAX_ATTEMPT_DELAY_MS
}

/**
 * Whether a dropped transport is worth reconnecting rather than finalizing.
 *
 * - Only endpoint_closed (socket-level drop, e.g. a network switch) is
 *   recoverable. stream_stopped_unexpectedly means the encoder wedged and
 *   errored means the pipeline failed — rebuilding on the same take is not
 *   trustworthy for either.
 * - everHadThroughput === false means nothing ever reached Mux; there is no
 *   recording to resume, and the never-started cancel path should run.
 * - A zero reconnect window (server default off, or an older server) means
 *   Mux already finalized the asset at the drop.
 */
export function shouldAttemptLiveReconnect({
  liveStatus,
  phase,
  reconnectWindowSeconds,
  everHadThroughput,
}: {
  liveStatus: LivePublishStatus
  phase: RecordingPhase
  reconnectWindowSeconds: number
  everHadThroughput: boolean | null
}): boolean {
  return (
    phase === 'recording' &&
    liveStatus === 'endpoint_closed' &&
    reconnectWindowSeconds > 0 &&
    everHadThroughput !== false
  )
}
