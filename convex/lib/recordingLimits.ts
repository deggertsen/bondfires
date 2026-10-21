import { MAX_RECORDING_SECONDS } from '../../packages/media/src/protocol'

type DurationCamp = {
  rules?: {
    participation?: {
      maxDurationMs?: number
    }
  }
} | null

/**
 * Camp rules are optional on legacy rows. A missing `rules` or `participation`
 * object must fall through to the product cap, not throw while starting an upload.
 */
export function recordingMaxDurationSeconds(
  camp: DurationCamp,
  tierLimitMs: number | undefined,
): number {
  return Math.min(
    (camp?.rules?.participation?.maxDurationMs ?? MAX_RECORDING_SECONDS * 1000) / 1000,
    MAX_RECORDING_SECONDS,
    (tierLimitMs ?? MAX_RECORDING_SECONDS * 1000) / 1000,
  )
}
