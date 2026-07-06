import { describe, expect, it } from 'vitest'
import type { RecordingPhase } from '../../../../packages/app/src/store/recording.store'
import { getRecordingWatchdogReset } from '../../../../packages/app/src/utils/recordingWatchdog'

describe('recording watchdog', () => {
  it('does not reset idle or post-recording phases', () => {
    for (const phase of ['idle', 'processing', 'uploading', 'completion'] as RecordingPhase[]) {
      expect(
        getRecordingWatchdogReset({
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
        phase: 'pre_connected',
        phaseStartedAt: 0,
        now: 60_000,
      }),
    ).toBeNull()

    expect(
      getRecordingWatchdogReset({
        phase: 'recording',
        phaseStartedAt: 0,
        now: 10 * 60_000,
      }),
    ).toBeNull()
  })

  it('returns reset telemetry for stuck tracked phases', () => {
    expect(
      getRecordingWatchdogReset({
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
        phase: 'recording',
        phaseStartedAt: null,
        now: 20 * 60_000,
      }),
    ).toBeNull()
  })
})
