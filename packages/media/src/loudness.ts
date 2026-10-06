/** Product loudness policy. Capture RMS is not an integrated LUFS measurement. */
export const LOUDNESS = {
  captureRmsDbfs: -18,
  capturePeakDbfs: -0.5,
  captureRms: 0.125893,
  capturePeak: 0.944061,
  noiseGate: 0.001778,
  maxGain: 31.6228,
  riseSeconds: 0.35,
  fallSeconds: 0.04,
  releaseSeconds: 0.15,
  integratedLufs: -16,
  truePeakDbtp: -1.5,
  maxProgramGainDb: 30,
} as const

export type LoudnessMeasurement = { integratedLufs: number; truePeakDbtp: number }

/** Bounded linear normalization preserves dynamics; peaks take precedence over LUFS.
 * Silence / ungated noise must never be lifted. Run DSP off the playback Worker.
 */
export function programGain(measured: LoudnessMeasurement, complete: boolean): number | null {
  if (!complete) return null
  const { integratedLufs, truePeakDbtp } = measured
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp)) return null
  if (integratedLufs < -55) return null
  return Math.min(
    LOUDNESS.maxProgramGainDb,
    LOUDNESS.integratedLufs - integratedLufs,
    LOUDNESS.truePeakDbtp - truePeakDbtp,
  )
}
