import { useEffect } from 'react'
import { telemetry } from '../services/telemetry'
import { recordingActions, recordingStore$ } from '../store/recording.store'
import {
  getRecordingWatchdogReset,
  RECORDING_WATCHDOG_INTERVAL_MS,
} from '../utils/recordingWatchdog'

export function useRecordingWatchdog() {
  useEffect(() => {
    const checkRecordingPhase = () => {
      const reset = getRecordingWatchdogReset({
        phase: recordingStore$.phase.peek(),
        phaseStartedAt: recordingStore$.phaseStartedAt.peek(),
        now: Date.now(),
      })

      if (!reset) {
        return
      }

      telemetry.warn('recording:watchdog-reset', 'Recording phase stuck; resetting to idle', reset)
      recordingActions.resetFlow('recording watchdog reset')
    }

    checkRecordingPhase()
    const interval = setInterval(checkRecordingPhase, RECORDING_WATCHDOG_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [])
}
