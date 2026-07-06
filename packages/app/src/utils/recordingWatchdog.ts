import type { RecordingPhase } from '../store/recording.store'

export const RECORDING_WATCHDOG_INTERVAL_MS = 30_000

const RECORDING_WATCHDOG_PHASE_TIMEOUT_MS: Partial<Record<RecordingPhase, number>> = {
  pre_connected: 60_000,
  recording: 10 * 60_000,
  stopping: 60_000,
}

export function getRecordingWatchdogReset({
  phase,
  phaseStartedAt,
  now,
}: {
  phase: RecordingPhase
  phaseStartedAt: number | null
  now: number
}) {
  const timeoutMs = RECORDING_WATCHDOG_PHASE_TIMEOUT_MS[phase]

  if (timeoutMs === undefined || phaseStartedAt === null) {
    return null
  }

  const elapsedMs = now - phaseStartedAt
  if (elapsedMs <= timeoutMs) {
    return null
  }

  return {
    phase,
    elapsedMs,
    timeoutMs,
  }
}
