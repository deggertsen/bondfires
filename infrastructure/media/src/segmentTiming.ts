import {
  InvalidSegmentDuration,
  inspectSegment,
  repairSingleSampleDuration,
  type Track,
} from '../../../packages/media/src/mp4'
import { MAX_SEGMENT_BYTES } from '../../../packages/media/src/protocol'

export type TranscriptionStorage = {
  get(key: string): Promise<Pick<R2ObjectBody, 'size' | 'arrayBuffer'> | null>
}

/** Preserve immutable uploaded bytes/checksums; normalize only validation and delivery. */
export async function normalizeTiming(
  env: { VIDEO: TranscriptionStorage },
  recordingId: string,
  index: number,
  bytes: Uint8Array,
  tracks: readonly Track[],
) {
  try {
    inspectSegment(bytes, tracks)
    return bytes
  } catch (error) {
    if (!(error instanceof InvalidSegmentDuration) || error.duration !== 0 || index <= 0)
      throw error
    const previous = await env.VIDEO.get(
      `${recordingId}/segment-${String(index - 1).padStart(6, '0')}.m4s`,
    )
    if (!previous || previous.size > MAX_SEGMENT_BYTES)
      throw new Error('Timing repair predecessor unavailable')
    const previousBytes = new Uint8Array(await previous.arrayBuffer())
    // Failure to obtain valid repair evidence does not prove the current
    // fragment unrepairable. Keep it within transcription's retry budget.
    try {
      inspectSegment(previousBytes, tracks)
    } catch {
      throw new Error('Invalid timing repair predecessor')
    }
    try {
      return repairSingleSampleDuration(bytes, tracks, previousBytes)
    } catch {
      // The bytes are still proven zero-duration if the narrow repair cannot
      // handle them. Preserve that classification for transcription diagnostics.
      throw error
    }
  }
}
