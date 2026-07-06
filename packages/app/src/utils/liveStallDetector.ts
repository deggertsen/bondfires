/**
 * Frozen-encoder detection over periodic live publisher throughput samples.
 *
 * Production telemetry (July 2026 camera-freeze investigation) shows the
 * dominant recording failure: the RTMP connection opens ("live") but the
 * capture pipeline never delivers a single frame — bitrate stays at zero
 * until Mux closes the idle connection 20–30s later, leaving the user on a
 * frozen REC screen and an errored asset. A rarer mode is an encoder that
 * stalls after healthy throughput. Both produce sustained ~zero bitrate
 * while the transport still reports itself open, which no connection-level
 * monitor can see.
 */

/**
 * Bitrate below this counts as "no media flowing". Android measures app-wide
 * TX bytes (TrafficStats), so ambient traffic — the Convex websocket,
 * telemetry flushes — must not read as throughput. A healthy stream publishes
 * ~2.5 Mbps video + 128 kbps audio, so 64 kbps cleanly separates the two.
 */
export const STALL_BITRATE_FLOOR_BPS = 64_000

/** Samples arrive every 5s; 3 zero samples after proven throughput ≈ 15s. */
export const STALL_SAMPLE_LIMIT = 3

/**
 * A stream that never produced a frame gets a slightly longer window
 * (4 × 5s = 20s) to rule out a slow first keyframe, while still beating
 * Mux's ~30s idle disconnect so we control the failure UX.
 */
export const NEVER_STARTED_SAMPLE_LIMIT = 4

export interface StallSample {
  bitrateBps: number
  /** False when the platform cannot measure real throughput (old native
   * builds, TrafficStats baseline sample) — such samples are ignored. */
  statsSupported: boolean
}

export type StallVerdict =
  | { stalled: false }
  | { stalled: true; neverStarted: boolean; samples: number }

export interface StallDetector {
  /** Whether any sample so far showed real throughput. */
  readonly sawThroughput: boolean
  /** Feed one sample taken while the publisher reports 'live'. */
  sample(sample: StallSample): StallVerdict
  /** Call for ticks where the publisher is not 'live' (connecting, etc.). */
  idle(): void
  reset(): void
}

export function createStallDetector(): StallDetector {
  let sawThroughput = false
  let zeroSamples = 0

  return {
    get sawThroughput() {
      return sawThroughput
    },
    reset() {
      sawThroughput = false
      zeroSamples = 0
    },
    idle() {
      zeroSamples = 0
    },
    sample({ bitrateBps, statsSupported }) {
      if (!statsSupported) {
        return { stalled: false }
      }
      if (bitrateBps >= STALL_BITRATE_FLOOR_BPS) {
        sawThroughput = true
        zeroSamples = 0
        return { stalled: false }
      }
      zeroSamples += 1
      const limit = sawThroughput ? STALL_SAMPLE_LIMIT : NEVER_STARTED_SAMPLE_LIMIT
      if (zeroSamples < limit) {
        return { stalled: false }
      }
      zeroSamples = 0
      return { stalled: true, neverStarted: !sawThroughput, samples: limit }
    },
  }
}
