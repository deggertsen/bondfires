import { useAction } from 'convex/react'
import { useEffect, useMemo } from 'react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { type BackgroundUploadOptions, resumePendingUploads } from '../services/backgroundUpload'
import { livePublishStore$ } from '../store/livePublish.store'
import { recordingStore$ } from '../store/recording.store'
import { uploadQueueActions } from '../store/uploadQueue.store'
import { uploadStatusActions } from '../store/uploadStatus.store'
import { isRecordingResourceLocked } from '../utils/recordingResourceLock'
import { useResumeUploads } from './useResumeUploads'
import { useUploadCompletion } from './useUploadCompletion'

/**
 * Legacy (single-file Mux) queue maintenance for non-segmented builds:
 * resumes pending tasks once per launch when the recording lock clears, and
 * lets the upload status banner restart the queue on demand ("Retry"/"Try again").
 */
export function useLegacyUploadResume() {
  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const createLiveBackupDirectUpload = useAction(api.videos.createLiveBackupDirectUpload)
  const waitForMuxUploadReady = useUploadCompletion()

  const options = useMemo(
    (): Omit<BackgroundUploadOptions, 'videoUri'> => ({
      isResponse: false,
      createMuxDirectUpload: async (args) =>
        await createMuxDirectUpload({
          ...args,
          bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
          campId: args.campId as Id<'camps'> | undefined,
          draftBondfireId: args.draftBondfireId as Id<'bondfires'> | undefined,
        }),
      createLiveBackupDirectUpload: async (args) =>
        await createLiveBackupDirectUpload({
          liveSessionId: args.liveSessionId as Id<'liveSessions'>,
          filename: args.filename,
          contentType: args.contentType,
          durationMs: args.durationMs,
          width: args.width,
          height: args.height,
        }),
      waitForMuxUploadReady: async (args) => await waitForMuxUploadReady(args),
    }),
    [createLiveBackupDirectUpload, createMuxDirectUpload, waitForMuxUploadReady],
  )

  // Without this, pending tasks only resumed after visiting and leaving create,
  // so the banner would report "uploading" for work that was not running.
  useResumeUploads(options)

  useEffect(() => {
    uploadStatusActions.setQueueEnabled(true)
    const unregister = uploadStatusActions.registerRetryHandler('queue', async () => {
      if (
        isRecordingResourceLocked({
          recordingPhase: recordingStore$.phase.peek(),
          liveStatus: livePublishStore$.status.peek(),
        })
      ) {
        return
      }
      uploadQueueActions.requeueFailed()
      await resumePendingUploads(options)
    })
    return () => {
      unregister()
      uploadStatusActions.setQueueEnabled(false)
    }
  }, [options])
}
