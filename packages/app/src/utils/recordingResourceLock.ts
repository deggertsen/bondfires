import type { RecordingPhase } from '../store/recording.store'

const LOCKED_RECORDING_PHASES = new Set<RecordingPhase>(['pre_connected', 'recording', 'stopping'])

export function isRecordingResourceLocked({ recordingPhase }: { recordingPhase: RecordingPhase }) {
  return LOCKED_RECORDING_PHASES.has(recordingPhase)
}
