import type { AppStateStatus } from 'react-native'
import {
  PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
  pictureInPictureStopAction,
  shouldResumeAfterPictureInPictureStop,
} from './videoPlayerState'

/** Only undo a pause introduced by PiP exit, never an existing pause or completion. */
export function createPictureInPicturePlayback({
  getPlayback,
  pause,
  resume,
}: {
  getPlayback: () => { isPlaying: boolean; canResume: boolean } | undefined
  pause: (appState: AppStateStatus) => void
  resume: (elapsedMs: number) => void
}) {
  let stoppedAt: number | null = null
  const cancel = () => {
    stoppedAt = null
  }

  return {
    cancel,
    stop(appState: AppStateStatus) {
      cancel()
      if (pictureInPictureStopAction(appState) === 'keep-playing') return
      const playback = getPlayback()
      if (!playback) return
      if (playback.isPlaying && playback.canResume) stoppedAt = Date.now()
      // Never defer this to a timer: background JS timers can be suspended.
      pause(appState)
    },
    onAppStateChange(appState: AppStateStatus) {
      if (stoppedAt === null) return
      const elapsedMs = Date.now() - stoppedAt
      if (
        appState !== 'active' &&
        elapsedMs >= 0 &&
        elapsedMs <= PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS
      ) {
        return
      }
      // Consume the opportunity even if playback is no longer eligible.
      cancel()
      if (
        shouldResumeAfterPictureInPictureStop({
          appState,
          elapsedMs,
          graceMs: PICTURE_IN_PICTURE_STOP_PAUSE_GRACE_MS,
        }) &&
        getPlayback()?.canResume
      ) {
        resume(elapsedMs)
      }
    },
  }
}
