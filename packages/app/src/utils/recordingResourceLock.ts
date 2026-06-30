import type { LivePublishStatus } from '../store/livePublish.store'
import type { RecordingPhase } from '../store/recording.store'

const LOCKED_RECORDING_PHASES = new Set<RecordingPhase>(['pre_connected', 'recording', 'stopping'])

const LOCKED_LIVE_STATUSES = new Set<LivePublishStatus>([
  'creating',
  'connecting',
  'live',
  'reconnecting',
  'stopping',
])

export function isRecordingResourceLocked({
  recordingPhase,
  liveStatus,
}: {
  recordingPhase: RecordingPhase
  liveStatus: LivePublishStatus
}) {
  return LOCKED_RECORDING_PHASES.has(recordingPhase) || LOCKED_LIVE_STATUSES.has(liveStatus)
}
