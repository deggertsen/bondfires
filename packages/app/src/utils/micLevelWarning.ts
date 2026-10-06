/** Native values exist only for measured, pre-gain PCM (never zero fallbacks). */
export interface MicLevelStats {
  micLevelDb?: number
  appliedGainDb?: number
  /** Native target - max gain - 2 dB margin, derived from the DSP constants. */
  micLowThresholdDb?: number
  /** Monotonic processed PCM count; unchanged means capture is stale. */
  micSampleCount?: number
  micMuted?: boolean
}

export const MIC_SAMPLE_INTERVAL_MS = 250
export const MIC_LOW_WINDOW_MS = 10_000
export const MIC_RECOVERY_MS = 500
export const MIC_MAX_SAMPLE_GAP_MS = 750

/**
 * Sample the native one-second power average at 4 Hz. Low includes silence
 * (a breath doesn't reset quiet speech). Allow <500 ms above the threshold
 * before declaring recovery. Missing/stale samples or gaps >750 ms reset the
 * window: two sparse low readings can never prove ten seconds of continuity.
 */
export function createMicLevelWarning() {
  let lowSince: number | null = null
  let recoverySince: number | null = null
  let lastAt: number | null = null
  let lastCount: number | null = null
  let visible = false

  function reset() {
    lowSince = null
    recoverySince = null
    lastAt = null
    lastCount = null
    visible = false
    return false
  }

  return {
    reset,
    sample(stats: MicLevelStats, now: number, recording: boolean): boolean {
      const { micLevelDb: level, micLowThresholdDb: threshold, micSampleCount: count } = stats
      if (
        !recording ||
        stats.micMuted !== false ||
        typeof level !== 'number' ||
        !Number.isFinite(level) ||
        typeof threshold !== 'number' ||
        !Number.isFinite(threshold) ||
        typeof count !== 'number' ||
        !Number.isFinite(count) ||
        count <= 0 ||
        !Number.isFinite(now)
      ) {
        return reset()
      }
      if (lastCount !== null && count === lastCount) return reset()
      if (
        (lastAt !== null && (now <= lastAt || now - lastAt > MIC_MAX_SAMPLE_GAP_MS)) ||
        (lastCount !== null && count < lastCount)
      ) {
        reset()
      }
      lastAt = now
      lastCount = count
      // Close the previous excursion before consuming the current reading.
      // A low poll can be the first observation at the recovery deadline.
      if (recoverySince !== null && now - recoverySince >= MIC_RECOVERY_MS) {
        lowSince = null
        visible = false
      }
      if (level <= threshold) {
        recoverySince = null
        lowSince ??= now
        visible = now - lowSince >= MIC_LOW_WINDOW_MS
      } else {
        recoverySince ??= now
      }
      return visible
    },
  }
}
