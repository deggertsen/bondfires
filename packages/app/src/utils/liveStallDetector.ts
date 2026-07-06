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
 * How often the publisher is polled for stats. The sample-count limits below
 * multiply against this — anyone tuning the cadence changes the detection
 * windows, so the hook must import this constant rather than hardcoding it.
 */
export const STATS_SAMPLE_INTERVAL_MS = 5_000

/**
 * Default bitrate floor below which a sample counts as "no media flowing".
 * Calibrated for Android, where the measurement is app-wide TX bytes
 * (TrafficStats): ambient traffic — the Convex websocket, telemetry flushes —
 * must not read as throughput. A healthy stream publishes ~2.5 Mbps video +
 * 128 kbps audio, so 64 kbps cleanly separates the two.
 *
 * iOS measures the actual RTMP stream (HaishinKit per-second byte counts), so
 * it uses an exact-zero floor instead (see IOS_STALL_BITRATE_FLOOR_BPS): a
 * genuinely low-bitrate stream (muted mic, static scene) must never be
 * misread as stalled, and the observed prod failures report literal zero.
 */
export const STALL_BITRATE_FLOOR_BPS = 64_000

/** Exact-zero semantics for per-stream measurements: any byte counts. */
export const IOS_STALL_BITRATE_FLOOR_BPS = 1

/** 3 zero samples after proven throughput ≈ 15s at the 5s cadence. */
export const STALL_SAMPLE_LIMIT = 3

/**
 * A stream that never produced a frame gets a slightly longer window
 * (4 × 5s = 20s) to rule out a slow first keyframe, while still beating
 * Mux's ~30s idle disconnect so we control the failure UX. (The hook primes
 * the Android TrafficStats baseline at start so the first 5s tick is already
 * a real measurement — without that the window would silently become 25s.)
 */
export const NEVER_STARTED_SAMPLE_LIMIT = 4

export interface StallSample {
  bitrateBps: number
  /** False when the platform cannot measure real throughput right now (old
   * native builds, TrafficStats baseline sample, concurrent bulk traffic
   * polluting an app-wide counter) — such samples are ignored. */
  statsSupported: boolean
}

export interface StallVerdict {
  stalled: boolean
  /** Whether this sample was a real measurement that updated the detector. */
  measured: boolean
  /** Cumulative: some measured sample this session showed real throughput. */
  sawThroughput: boolean
  /** Set when stalled: no measured sample ever showed throughput. */
  neverStarted?: boolean
  /** Set when stalled: how many consecutive zero samples triggered it. */
  samples?: number
}

export interface StallDetector {
  /** Feed one sample taken while the publisher reports 'live'. */
  sample(sample: StallSample): StallVerdict
  /** Call for ticks where the publisher is not 'live' (connecting, etc.). */
  idle(): void
  reset(): void
}

export function createStallDetector(floorBps: number = STALL_BITRATE_FLOOR_BPS): StallDetector {
  let sawThroughput = false
  let zeroSamples = 0

  return {
    reset() {
      sawThroughput = false
      zeroSamples = 0
    },
    idle() {
      zeroSamples = 0
    },
    sample({ bitrateBps, statsSupported }) {
      if (!statsSupported) {
        return { stalled: false, measured: false, sawThroughput }
      }
      if (bitrateBps >= floorBps) {
        sawThroughput = true
        zeroSamples = 0
        return { stalled: false, measured: true, sawThroughput }
      }
      zeroSamples += 1
      const limit = sawThroughput ? STALL_SAMPLE_LIMIT : NEVER_STARTED_SAMPLE_LIMIT
      if (zeroSamples < limit) {
        return { stalled: false, measured: true, sawThroughput }
      }
      zeroSamples = 0
      return {
        stalled: true,
        measured: true,
        sawThroughput,
        neverStarted: !sawThroughput,
        samples: limit,
      }
    },
  }
}
