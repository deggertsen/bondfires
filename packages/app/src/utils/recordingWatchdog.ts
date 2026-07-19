import type { RecordingPhase } from '../store/recording.store'

export const RECORDING_WATCHDOG_INTERVAL_MS = 30_000
export const MAX_CONSECUTIVE_PRE_CONNECT_RESETS = 3

const RECORDING_WATCHDOG_PHASE_TIMEOUT_MS: Partial<Record<RecordingPhase, number>> = {
  // Camera preview should start in 2-3s. 30s is a generous upper bound that
  // avoids false positives on slow devices while not leaving the user stuck
  // on "Preparing camera..." for a full minute.
  pre_connected: 30_000,
  stopping: 60_000,
}

export function getNextPreConnectResetCount(
  currentCount: number,
  resetPhase: RecordingPhase,
): number {
  return resetPhase === 'pre_connected' ? currentCount + 1 : 0
}

/**
 * How long the 'recording' phase may go without a duration tick before it is
 * considered stuck. The active record screen ticks recordingDuration every
 * second while phase === 'recording' (regardless of transport state), so this
 * is a screen-liveness heartbeat: 90s of foreground time without a single
 * tick means the owning screen is gone and the phase is orphaned.
 *
 * The 'recording' phase deliberately has NO wall-clock timeout. A healthy
 * recording can legitimately run for any duration the camp/tier allows — a
 * previous 10-minute phase-age timeout here reset the flow mid-recording,
 * which snapped the UI back to idle and led the unmount cleanup to cancel
 * (server-side delete) streams that were publishing perfectly, destroying
 * users' recordings at the 10-minute mark on both platforms.
 */
export const RECORDING_NO_PROGRESS_TIMEOUT_MS = 90_000

export function getRecordingWatchdogReset({
  phase,
  phaseStartedAt,
  lastProgressAt,
  isAppActive,
  now,
}: {
  phase: RecordingPhase
  phaseStartedAt: number | null
  /** When recordingDuration last ticked (or the app last became active). */
  lastProgressAt: number | null
  /**
   * JS timers pause while backgrounded, so a paused ticker is not evidence of
   * a stuck phase. Background teardown is handled separately by the screens.
   */
  isAppActive: boolean
  now: number
}) {
  if (phaseStartedAt === null) {
    return null
  }

  if (phase === 'recording') {
    if (!isAppActive) {
      return null
    }
    const progressAt = Math.max(phaseStartedAt, lastProgressAt ?? 0)
    const sinceProgressMs = now - progressAt
    if (sinceProgressMs <= RECORDING_NO_PROGRESS_TIMEOUT_MS) {
      return null
    }
    return {
      phase,
      elapsedMs: now - phaseStartedAt,
      sinceProgressMs,
      timeoutMs: RECORDING_NO_PROGRESS_TIMEOUT_MS,
    }
  }

  const timeoutMs = RECORDING_WATCHDOG_PHASE_TIMEOUT_MS[phase]

  if (timeoutMs === undefined) {
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
