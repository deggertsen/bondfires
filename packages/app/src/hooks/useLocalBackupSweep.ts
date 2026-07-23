import { useConvex } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { sweepLocalBackups } from '../services/localBackupSweep'
import { telemetry } from '../services/telemetry'
import { useRecordingResourceLock } from './useRecordingResourceLock'

/**
 * Run the local backup sweep once on app start (Phase 1 of
 * docs/plans/local-backup-recording.md): expired backup files are deleted,
 * files whose live asset resolved to 'ready' are deleted, the rest are kept.
 *
 * Same gating pattern as useResumeUploads: waits until the recording resource
 * lock clears so the sweep never competes with the camera/encoder path, then
 * runs exactly once for the app session. Fully fire-and-forget.
 */
export function useLocalBackupSweep() {
  const convex = useConvex()
  const hasRun = useRef(false)
  const recordingResourceLocked = useRecordingResourceLock()

  useEffect(() => {
    // Only run once on mount
    if (hasRun.current) return
    if (recordingResourceLocked) return
    hasRun.current = true

    sweepLocalBackups({
      getLiveSessionRecordStatus: (args) =>
        convex.query(api.videos.getLiveSessionRecordStatus, {
          liveSessionId: args.liveSessionId as Id<'liveSessions'>,
        }),
    }).catch((error) => {
      telemetry.warn('backup:sweep_failed', 'Local backup sweep crashed', {
        error: String(error),
      })
    })
  }, [convex, recordingResourceLocked])
}
