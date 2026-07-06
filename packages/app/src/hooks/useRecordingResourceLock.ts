import { useValue } from '@legendapp/state/react'
import { livePublishStore$ } from '../store/livePublish.store'
import { recordingStore$ } from '../store/recording.store'
import { isRecordingResourceLocked } from '../utils/recordingResourceLock'

/**
 * True while the recording path needs camera/encoder/heap headroom.
 *
 * Screens that can remain mounted underneath create/recording should use this
 * to pause nonessential background work such as thumbnail preloading, upload
 * resume, and broad list subscriptions.
 */
export function useRecordingResourceLock() {
  const recordingPhase = useValue(recordingStore$.phase)
  const liveStatus = useValue(livePublishStore$.status)

  return isRecordingResourceLocked({ recordingPhase, liveStatus })
}

export function useCanRunRecordingBackgroundWork(isFocused: boolean) {
  const recordingResourceLocked = useRecordingResourceLock()

  return isFocused && !recordingResourceLocked
}

export function useCanLoadTabData(isFocused: boolean) {
  return isFocused
}
