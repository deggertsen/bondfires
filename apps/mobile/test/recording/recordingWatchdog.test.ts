import { describe, expect, it } from 'vitest'
import type { RecordingPhase } from '../../../../packages/app/src/store/recording.store'
import {
  getRecordingWatchdogReset,
  RECORDING_NO_PROGRESS_TIMEOUT_MS,
} from '../../../../packages/app/src/utils/recordingWatchdog'

const base = { lastProgressAt: null, isAppActive: true }

describe('recording watchdog', () => {
  it('does not reset idle or post-recording phases', () => {
    for (const phase of ['idle', 'processing', 'uploading', 'completion'] as RecordingPhase[]) {
      expect(
        getRecordingWatchdogReset({
          ...base,
          phase,
          phaseStartedAt: 0,
          now: 20 * 60_000,
        }),
      ).toBeNull()
    }
  })

  it('does not reset tracked phases before or at their timeout', () => {
    expect(
      getRecordingWatchdogReset({
        ...base,
        phase: 'pre_connected',
        phaseStartedAt: 0,
        now: 60_000,
      }),
    ).toBeNull()
  })

  it('returns reset telemetry for stuck tracked phases', () => {
    expect(
      getRecordingWatchdogReset({
        ...base,
        phase: 'pre_connected',
        phaseStartedAt: 1_000,
        now: 62_000,
      }),
    ).toEqual({
      phase: 'pre_connected',
      elapsedMs: 61_000,
      timeoutMs: 60_000,
    })

    expect(
      getRecordingWatchdogReset({
        ...base,
        phase: 'stopping',
        phaseStartedAt: 0,
        now: 60_001,
      }),
    ).toEqual({
      phase: 'stopping',
      elapsedMs: 60_001,
      timeoutMs: 60_000,
    })
  })

  it('ignores tracked phases without a start timestamp', () => {
    expect(
      getRecordingWatchdogReset({
        ...base,
        phase: 'recording',
        phaseStartedAt: null,
        now: 20 * 60_000,
      }),
    ).toBeNull()
  })

  describe('recording phase (no-progress heartbeat)', () => {
    it('never resets a recording whose duration keeps ticking, regardless of length', () => {
      // 45 minutes in, ticker stamped 1s ago — a healthy long recording.
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 0,
          lastProgressAt: 45 * 60_000 - 1_000,
          isAppActive: true,
          now: 45 * 60_000,
        }),
      ).toBeNull()
    })

    it('does not reset before the no-progress timeout elapses', () => {
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 0,
          lastProgressAt: 10 * 60_000,
          isAppActive: true,
          now: 10 * 60_000 + RECORDING_NO_PROGRESS_TIMEOUT_MS,
        }),
      ).toBeNull()
    })

    it('resets a recording phase with no ticks for the full timeout while active', () => {
      const now = 10 * 60_000 + RECORDING_NO_PROGRESS_TIMEOUT_MS + 1
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 0,
          lastProgressAt: 10 * 60_000,
          isAppActive: true,
          now,
        }),
      ).toEqual({
        phase: 'recording',
        elapsedMs: now,
        sinceProgressMs: RECORDING_NO_PROGRESS_TIMEOUT_MS + 1,
        timeoutMs: RECORDING_NO_PROGRESS_TIMEOUT_MS,
      })
    })

    it('measures from phase start when no tick has landed yet', () => {
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 60_000,
          lastProgressAt: null,
          isAppActive: true,
          now: 60_000 + RECORDING_NO_PROGRESS_TIMEOUT_MS + 1,
        }),
      ).toMatchObject({ phase: 'recording' })
    })

    it('uses the freshest of phase start and last tick', () => {
      // Stale tick from a previous attempt; the new phase just started.
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 100_000,
          lastProgressAt: 1_000,
          isAppActive: true,
          now: 100_000 + RECORDING_NO_PROGRESS_TIMEOUT_MS,
        }),
      ).toBeNull()
    })

    it('never resets while the app is backgrounded (timers pause, not stuck)', () => {
      expect(
        getRecordingWatchdogReset({
          phase: 'recording',
          phaseStartedAt: 0,
          lastProgressAt: 0,
          isAppActive: false,
          now: 60 * 60_000,
        }),
      ).toBeNull()
    })
  })
})
