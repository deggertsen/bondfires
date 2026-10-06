import {
  LOUDNESS,
  type LoudnessMeasurement,
  programGain,
} from '../../../packages/media/src/loudness.ts'

/** Offline compute contract only. Not executed in the Worker fetch path.
 * Publication of a completed R2 rendition remains a separate integration step.
 */
export function normalizationFilter(measured: LoudnessMeasurement, complete: boolean): string {
  const gain = programGain(measured, complete)
  if (gain === null) throw new Error('Normalization requires completed, measurable audio')
  return `volume=${gain}dB`
}

/** Measure the encoded result too: AAC can introduce additional true peaks. */
export function verifyNormalizedAudio(
  before: LoudnessMeasurement,
  after: LoudnessMeasurement,
): boolean {
  const gain = programGain(before, true)
  return (
    gain !== null &&
    Number.isFinite(after.integratedLufs) &&
    Number.isFinite(after.truePeakDbtp) &&
    Math.abs(after.integratedLufs - (before.integratedLufs + gain)) <= 0.5 &&
    after.truePeakDbtp <= LOUDNESS.truePeakDbtp
  )
}
