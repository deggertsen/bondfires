import { useEffect, useRef } from 'react'
import { type BackgroundUploadOptions, resumePendingUploads } from '../services/backgroundUpload'

/**
 * Hook to resume pending uploads on app startup
 */
export function useResumeUploads(options: Omit<BackgroundUploadOptions, 'videoUri'>) {
  const hasRun = useRef(false)

  useEffect(() => {
    // Only run once on mount
    if (hasRun.current) return
    hasRun.current = true

    // Resume pending uploads when component mounts
    resumePendingUploads(options).catch((error) => {
      console.error('[useResumeUploads] Failed to resume uploads:', error)
    })
  }, [options])
}
