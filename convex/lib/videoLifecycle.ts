/** Playback availability is independent of audience authorization and invite access. */
export type VideoLifecycleRecord = {
  status?: string
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  muxUploadId?: string
  liveSessionId?: string
  segmentRecordingId?: string
  draftExpiresAt?: number
  expiresAt?: number
}
export type VideoLifecycle =
  | 'awaiting_recording'
  | 'uploading'
  | 'live'
  | 'ready'
  | 'recovering'
  | 'failed'
  | 'expired'

export function getVideoLifecycle(record: VideoLifecycleRecord, now = Date.now()): VideoLifecycle {
  if (
    (record.expiresAt !== undefined && record.expiresAt <= now) ||
    (record.status === 'draft' &&
      record.draftExpiresAt !== undefined &&
      record.draftExpiresAt <= now)
  )
    return 'expired'
  switch (record.videoStatus ?? 'ready') {
    case 'pending':
      return 'awaiting_recording'
    case 'waiting_for_upload':
    case 'processing':
      return 'uploading'
    case 'awaiting_recovery':
      return 'recovering'
    case 'live':
      return record.muxLivePlaybackId || record.segmentRecordingId ? 'live' : 'uploading'
    case 'ready':
      return record.muxPlaybackId || record.segmentRecordingId ? 'ready' : 'failed'
    default:
      return 'failed'
  }
}

/** Feeds require playback; direct-link detail queries separately enforce authorization. */
export function isPlayableVideoRecord(record: VideoLifecycleRecord) {
  const state = getVideoLifecycle(record)
  return state === 'live' || state === 'ready'
}

export function canResumeUnrecordedDraft(record: VideoLifecycleRecord, now = Date.now()) {
  return (
    record.status === 'draft' &&
    getVideoLifecycle(record, now) === 'awaiting_recording' &&
    !record.segmentRecordingId &&
    !record.liveSessionId &&
    !record.muxUploadId &&
    !record.muxPlaybackId &&
    !record.muxLivePlaybackId
  )
}

/** Receipts are ordered and durable. Never publish an empty or uninitialized recording. */
export function getSegmentVideoStatus(record: {
  status: string
  initChecksum?: string
  segmentCount: number
  finalCount?: number
  duration: number
}): 'waiting_for_upload' | 'live' | 'ready' | 'errored' {
  if (record.status === 'cancelled') return 'errored'
  if (!record.initChecksum || record.segmentCount < 1) return 'waiting_for_upload'
  if (record.finalCount === record.segmentCount) return 'ready'
  return record.duration >= 8 ? 'live' : 'waiting_for_upload'
}
