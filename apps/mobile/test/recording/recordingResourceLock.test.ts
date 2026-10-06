import { describe, expect, it } from 'vitest'
import type { RecordingPhase } from '../../../../packages/app/src/store/recording.store'
import { isRecordingResourceLocked } from '../../../../packages/app/src/utils/recordingResourceLock'

describe('recording resource lock', () => {
  it('locks while the camera needs resource headroom', () => {
    for (const recordingPhase of ['pre_connected', 'recording', 'stopping'] as RecordingPhase[]) {
      expect(isRecordingResourceLocked({ recordingPhase })).toBe(true)
    }
  })

  it('does not lock after recording has left the camera path', () => {
    for (const recordingPhase of [
      'idle',
      'processing',
      'uploading',
      'completion',
    ] as RecordingPhase[]) {
      expect(isRecordingResourceLocked({ recordingPhase })).toBe(false)
    }
  })
})
