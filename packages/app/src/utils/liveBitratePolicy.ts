/**
 * Publisher-side adaptive bitrate for live RTMP.
 *
 * Industry pattern (OBS / Streamlabs Dynamic Bitrate, HaishinKit QoS delegates,
 * modern RTMP publisher ABR controllers):
 *   - Start at a configured ceiling
 *   - Cut quickly when the uplink cannot sustain the encoder target
 *   - Recover slowly with hysteresis so we don't sawtooth
 *   - Never key off transport type (Wi‑Fi vs cellular) — only observed capacity
 *
 * Our observable proxy for capacity is achieved upload bitrate vs the
 * configured encoder target (video + audio). That matches what mobile RTMP
 * stacks can measure today: HaishinKit stream bytes on iOS, TrafficStats TX
 * deltas on Android. Send-queue depth (OBS's gold signal) is not exposed.
 */

export const LIVE_VIDEO_BITRATE_LADDER = [
  2_500_000, // tier 0 — nominal ceiling
  1_500_000, // tier 1 — mild congestion
  1_000_000, // tier 2 — serious congestion
  600_000, // tier 3 — survival floor
] as const

export type LiveVideoBitrateTier = 0 | 1 | 2 | 3

/** Default audio bitrate paired with live video encode settings. */
export const LIVE_AUDIO_BITRATE_BPS = 128_000

/** Achieved < this fraction of expected → congested sample. */
export const ABR_DOWN_RATIO = 0.7

/** Achieved ≥ this fraction of expected → healthy sample (stricter than down). */
export const ABR_UP_RATIO = 0.9

/** Consecutive congested samples before stepping down (~10s at 5s cadence). */
export const ABR_DOWN_SAMPLE_LIMIT = 2

/** Consecutive healthy samples before stepping up (~20s at 5s cadence). */
export const ABR_UP_SAMPLE_LIMIT = 4

/**
 * After a downstep, suppress up-probes for this many measured samples (~10s).
 * Matches the post-cut hold used by RTMP ABR controllers to avoid immediate
 * re-congestion.
 */
export const ABR_POST_CUT_HOLD_SAMPLES = 2

export interface NetworkBitrateSample {
  /** Measured upload bitrate (bps). */
  bitrateBps: number
  /** False when the platform cannot measure real throughput — ignored. */
  statsSupported: boolean
}

export type NetworkBitrateDecision =
  | { action: 'hold'; tier: LiveVideoBitrateTier; bitrate: number }
  | {
      action: 'step_down' | 'step_up'
      tier: LiveVideoBitrateTier
      bitrate: number
      fromTier: LiveVideoBitrateTier
      achievedBps: number
      expectedBps: number
    }

export interface NetworkBitrateController {
  reset(initialTier?: LiveVideoBitrateTier): void
  /** Current network-imposed video bitrate ceiling. */
  bitrate(): number
  tier(): LiveVideoBitrateTier
  /**
   * Feed one stats sample taken while live. Returns whether the network tier
   * changed so the caller can apply encoder settings.
   */
  sample(sample: NetworkBitrateSample): NetworkBitrateDecision
}

function ladderBitrate(tier: LiveVideoBitrateTier): number {
  return LIVE_VIDEO_BITRATE_LADDER[tier]
}

function clampTier(tier: number): LiveVideoBitrateTier {
  if (tier <= 0) return 0
  if (tier >= LIVE_VIDEO_BITRATE_LADDER.length - 1) {
    return (LIVE_VIDEO_BITRATE_LADDER.length - 1) as LiveVideoBitrateTier
  }
  return tier as LiveVideoBitrateTier
}

/** Effective encoder bitrate after composing network + thermal ceilings. */
export function composeLiveVideoBitrate(
  networkBitrateCap: number,
  thermalBitrateCap: number,
): number {
  return Math.min(networkBitrateCap, thermalBitrateCap)
}

export function createNetworkBitrateController(
  audioBitrateBps: number = LIVE_AUDIO_BITRATE_BPS,
): NetworkBitrateController {
  let tier: LiveVideoBitrateTier = 0
  let badSamples = 0
  let goodSamples = 0
  let holdSamplesRemaining = 0

  const expectedBps = () => ladderBitrate(tier) + audioBitrateBps

  return {
    reset(initialTier: LiveVideoBitrateTier = 0) {
      tier = clampTier(initialTier)
      badSamples = 0
      goodSamples = 0
      holdSamplesRemaining = 0
    },

    bitrate() {
      return ladderBitrate(tier)
    },

    tier() {
      return tier
    },

    sample({ bitrateBps, statsSupported }): NetworkBitrateDecision {
      if (!statsSupported) {
        return { action: 'hold', tier, bitrate: ladderBitrate(tier) }
      }

      const expected = expectedBps()
      const congested = bitrateBps < expected * ABR_DOWN_RATIO
      const healthy = bitrateBps >= expected * ABR_UP_RATIO
      const inPostCutHold = holdSamplesRemaining > 0
      if (inPostCutHold) {
        holdSamplesRemaining -= 1
      }

      if (congested) {
        goodSamples = 0
        badSamples += 1
        if (badSamples >= ABR_DOWN_SAMPLE_LIMIT && tier < LIVE_VIDEO_BITRATE_LADDER.length - 1) {
          const fromTier = tier
          tier = clampTier(tier + 1)
          badSamples = 0
          goodSamples = 0
          holdSamplesRemaining = ABR_POST_CUT_HOLD_SAMPLES
          return {
            action: 'step_down',
            tier,
            bitrate: ladderBitrate(tier),
            fromTier,
            achievedBps: bitrateBps,
            expectedBps: expected,
          }
        }
        return { action: 'hold', tier, bitrate: ladderBitrate(tier) }
      }

      if (healthy) {
        badSamples = 0
        // Suppress up-probes during the post-cut hold so we don't immediately
        // climb back into congestion (OBS / RTMP ABR hysteresis).
        if (inPostCutHold || tier === 0) {
          goodSamples = 0
          return { action: 'hold', tier, bitrate: ladderBitrate(tier) }
        }
        goodSamples += 1
        if (goodSamples >= ABR_UP_SAMPLE_LIMIT) {
          const fromTier = tier
          tier = clampTier(tier - 1)
          goodSamples = 0
          badSamples = 0
          return {
            action: 'step_up',
            tier,
            bitrate: ladderBitrate(tier),
            fromTier,
            achievedBps: bitrateBps,
            expectedBps: expected,
          }
        }
        return { action: 'hold', tier, bitrate: ladderBitrate(tier) }
      }

      // Ambiguous band (between down and up thresholds) — reset streaks so a
      // flicker through the middle cannot accumulate into a step.
      badSamples = 0
      goodSamples = 0
      return { action: 'hold', tier, bitrate: ladderBitrate(tier) }
    },
  }
}
