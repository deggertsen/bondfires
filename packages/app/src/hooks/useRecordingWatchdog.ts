import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { telemetry } from '../services/telemetry'
import { recordingActions, recordingStore$ } from '../store/recording.store'
import {
  getNextPreConnectResetCount,
  getRecordingWatchdogReset,
  MAX_CONSECUTIVE_PRE_CONNECT_RESETS,
  RECORDING_WATCHDOG_INTERVAL_MS,
} from '../utils/recordingWatchdog'

export function useRecordingWatchdog() {
  const consecutivePreConnectResetsRef = useRef(0)

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
      // The recording phase is making progress — clear the consecutive reset
      // counter since the flow is healthy.
      consecutivePreConnectResetsRef.current = 0
    })
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        lastProgressAt = Date.now()
      }
    })

    // `idle` is deliberately not healthy progress here: resetFlow() transitions
    // to idle after every watchdog timeout, and the create screen immediately
    // re-arms the preview. Clearing on idle would make the streak stay at 1
    // forever. A real recording transition proves the pipeline recovered.
    const phaseSub = recordingStore$.phase.onChange(({ value }) => {
      if (value === 'recording') {
        consecutivePreConnectResetsRef.current = 0
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

      const consecutiveResets = getNextPreConnectResetCount(
        consecutivePreConnectResetsRef.current,
        reset.phase,
      )
      consecutivePreConnectResetsRef.current = consecutiveResets

      if (consecutiveResets >= MAX_CONSECUTIVE_PRE_CONNECT_RESETS) {
        // Too many consecutive resets — the recording pipeline is consistently
        // stuck. Surface an error so the UI can show a user-visible message
        // instead of silently looping in the background.
        telemetry.error(
          'recording:watchdog-stuck',
          'Recording phase repeatedly stuck; giving up after consecutive resets',
          { ...reset, consecutiveResets },
        )
        recordingStore$.preConnectFailed.set(true)
        recordingActions.resetFlow('recording watchdog stuck')
        consecutivePreConnectResetsRef.current = 0
      } else {
        telemetry.warn('recording:watchdog-reset', 'Recording phase stuck; resetting to idle', {
          ...reset,
          consecutiveResets,
        })
        recordingActions.resetFlow('recording watchdog reset')
      }
    }

    checkRecordingPhase()
    const interval = setInterval(checkRecordingPhase, RECORDING_WATCHDOG_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      durationSub()
      appStateSub.remove()
      phaseSub()
    }
  }, [])
}
