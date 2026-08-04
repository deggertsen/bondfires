import { useAction, useConvex } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { startLiveBackupUpload } from '../services/backgroundUpload'
import { sweepLocalBackups } from '../services/localBackupSweep'
import { telemetry } from '../services/telemetry'
import { toastActions } from '../store/toast.store'
import { useRecordingResourceLock } from './useRecordingResourceLock'

const RECOVERY_TOAST_MESSAGE =
  "Finishing an upload from an earlier recording. It'll appear once it's done."

/**
 * Run the local backup sweep once on app start (Phase 1+2 of
 * docs/plans/local-backup-recording.md): expired backup files are deleted,
 * files whose live asset resolved to 'ready' are deleted, recovery-eligible
 * leftovers are enqueued as live_backup uploads.
 *
 * Same gating pattern as useResumeUploads: waits until the recording resource
 * lock clears so the sweep never competes with the camera/encoder path, then
 * runs exactly once for the app session. Fully fire-and-forget.
 */
export function useLocalBackupSweep() {
  const convex = useConvex()
  const createLiveBackupDirectUpload = useAction(api.videos.createLiveBackupDirectUpload)
  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const getMuxUploadStatus = useAction(api.videos.getMuxUploadStatus)
  const hasRun = useRef(false)
  const recordingResourceLocked = useRecordingResourceLock()

  useEffect(() => {
    // Only run once on mount
    if (hasRun.current) return
    if (recordingResourceLocked) return
    hasRun.current = true

    // One passive heads-up per sweep no matter how many sessions it recovers:
    // the user shouldn't have to guess why an old recording is still missing.
    let announcedRecovery = false

    sweepLocalBackups({
      getLiveSessionRecordStatus: (args) =>
        convex.query(api.videos.getLiveSessionRecordStatus, {
          liveSessionId: args.liveSessionId as Id<'liveSessions'>,
        }),
      enqueueLiveBackupRecovery: async (args) => {
        await startLiveBackupUpload({
          videoUri: args.fileUri,
          liveSessionId: args.liveSessionId,
          recordId: args.recordId ?? undefined,
          recordType: args.recordType ?? undefined,
          isResponse: args.recordType === 'response',
          createLiveBackupDirectUpload: async (uploadArgs) =>
            await createLiveBackupDirectUpload({
              liveSessionId: uploadArgs.liveSessionId as Id<'liveSessions'>,
              filename: uploadArgs.filename,
              contentType: uploadArgs.contentType,
              durationMs: uploadArgs.durationMs,
              width: uploadArgs.width,
              height: uploadArgs.height,
            }),
          createMuxDirectUpload: async (uploadArgs) =>
            await createMuxDirectUpload({
              ...uploadArgs,
              bondfireId: uploadArgs.bondfireId as Id<'bondfires'> | undefined,
              campId: uploadArgs.campId as Id<'camps'> | undefined,
              draftBondfireId: uploadArgs.draftBondfireId as Id<'bondfires'> | undefined,
            }),
          getMuxUploadStatus: async (statusArgs) => await getMuxUploadStatus(statusArgs),
        })

        if (!announcedRecovery) {
          announcedRecovery = true
          toastActions.addToast('info', RECOVERY_TOAST_MESSAGE)
        }
      },
    }).catch((error) => {
      telemetry.warn('backup:sweep_failed', 'Local backup sweep crashed', {
        error: String(error),
      })
    })
  }, [
    convex,
    createLiveBackupDirectUpload,
    createMuxDirectUpload,
    getMuxUploadStatus,
    recordingResourceLocked,
  ])
}
