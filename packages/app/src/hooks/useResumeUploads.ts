import { useEffect, useRef } from 'react'
import { type BackgroundUploadOptions, resumePendingUploads } from '../services/backgroundUpload'
import { telemetry } from '../services/telemetry'
import { useRecordingResourceLock } from './useRecordingResourceLock'

/**
 * Hook to resume pending uploads on app startup
 */
export function useResumeUploads(options: Omit<BackgroundUploadOptions, 'videoUri'>) {
  const hasRun = useRef(false)
  const recordingResourceLocked = useRecordingResourceLock()

  useEffect(() => {
    // Only run once on mount
    if (hasRun.current) return
    if (recordingResourceLocked) return
    hasRun.current = true

    // Resume pending uploads when component mounts
    resumePendingUploads(options).catch((error) => {
      telemetry.error('upload:resume', 'Failed to resume uploads', { error: String(error) })
    })
  }, [options, recordingResourceLocked])
}
