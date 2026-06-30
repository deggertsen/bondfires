import { describe, expect, it } from 'vitest'
import type { LivePublishStatus } from '../../../../packages/app/src/store/livePublish.store'
import type { RecordingPhase } from '../../../../packages/app/src/store/recording.store'
import { isRecordingResourceLocked } from '../../../../packages/app/src/utils/recordingResourceLock'

describe('recording resource lock', () => {
  it('locks while the camera or live transport needs resource headroom', () => {
    for (const recordingPhase of ['pre_connected', 'recording', 'stopping'] as RecordingPhase[]) {
      expect(isRecordingResourceLocked({ recordingPhase, liveStatus: 'idle' })).toBe(true)
    }

    for (const liveStatus of [
      'creating',
      'connecting',
      'live',
      'reconnecting',
      'stopping',
    ] as LivePublishStatus[]) {
      expect(isRecordingResourceLocked({ recordingPhase: 'idle', liveStatus })).toBe(true)
    }
  })

  it('does not lock after recording has left the camera path', () => {
    for (const recordingPhase of [
      'idle',
      'processing',
      'uploading',
      'completion',
    ] as RecordingPhase[]) {
      expect(isRecordingResourceLocked({ recordingPhase, liveStatus: 'idle' })).toBe(false)
    }

    for (const liveStatus of [
      'idle',
      'ready',
      'ended',
      'errored',
      'stream_stopped_unexpectedly',
      'endpoint_closed',
    ] as LivePublishStatus[]) {
      expect(isRecordingResourceLocked({ recordingPhase: 'idle', liveStatus })).toBe(false)
    }
  })
})
