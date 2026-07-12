import { useEffect } from 'react'
import { AppState } from 'react-native'
import { telemetry } from '../services/telemetry'
import { recordingActions, recordingStore$ } from '../store/recording.store'
import {
  getRecordingWatchdogReset,
  RECORDING_WATCHDOG_INTERVAL_MS,
} from '../utils/recordingWatchdog'

export function useRecordingWatchdog() {
  useEffect(() => {
    // Heartbeat for the 'recording' phase: the active record screen ticks
    // recordingDuration every second, so a fresh stamp here proves the owning
    // screen is alive. Also stamped when the app returns to the foreground —
    // both the ticker and this watchdog pause while backgrounded, and on
    // resume their intervals race; without the re-stamp the watchdog could
    // read a stale timestamp and reset a healthy recording before the ticker
    // gets its first post-resume tick.
    let lastProgressAt = Date.now()
    const durationSub = recordingStore$.recordingDuration.onChange(() => {
      lastProgressAt = Date.now()
    })
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        lastProgressAt = Date.now()
      }
    })

    const checkRecordingPhase = () => {
      const reset = getRecordingWatchdogReset({
        phase: recordingStore$.phase.peek(),
        phaseStartedAt: recordingStore$.phaseStartedAt.peek(),
        lastProgressAt,
        isAppActive: AppState.currentState === 'active',
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
      durationSub()
      appStateSub.remove()
    }
  }, [])
}
