import { observable } from '@legendapp/state'
import { telemetry } from '../services/telemetry'
import {
  deriveUploadStatus,
  type SegmentJobStatus,
  type UploadCompletion,
  type UploadStatusState,
} from '../utils/uploadStatus'
import { uiStore$ } from './ui.store'
import { uploadQueueStore$ } from './uploadQueue.store'

// Transient (not persisted): segmented jobs are re-reported from the durable
// journal within one upload tick, and the legacy queue persists on its own.
interface UploadStatusStoreState {
  segmentJobs: SegmentJobStatus[]
  lastCompletion: UploadCompletion | null
  completionDismissedAt: number
  /** True only where the legacy queue actually runs (non-segmented builds). */
  queueEnabled: boolean
  /** Re-evaluation clock for the completion hold. */
  clock: number
  /** Measured height of the banner, 0 while hidden; offsets toasts below it. */
  bannerHeight: number
}

export const uploadStatusStore$ = observable<UploadStatusStoreState>({
  segmentJobs: [],
  lastCompletion: null,
  completionDismissedAt: 0,
  queueEnabled: false,
  clock: Date.now(),
  bannerHeight: 0,
})

export const uploadStatus$ = observable<UploadStatusState>(() =>
  deriveUploadStatus({
    segmentJobs: uploadStatusStore$.segmentJobs.get(),
    tasks: uploadQueueStore$.tasks.get() ?? [],
    queueEnabled: uploadStatusStore$.queueEnabled.get(),
    isOnline: uiStore$.isOnline.get(),
    lastCompletion: uploadStatusStore$.lastCompletion.get(),
    completionDismissedAt: uploadStatusStore$.completionDismissedAt.get(),
    now: uploadStatusStore$.clock.get(),
  }),
)

type RetryHandler = () => void | Promise<void>
const retryHandlers = new Map<string, RetryHandler>()

export const uploadStatusActions = {
  setSegmentJobs: (jobs: SegmentJobStatus[]) => uploadStatusStore$.segmentJobs.set(jobs),

  recordCompletion: (completion: Omit<UploadCompletion, 'at'>) => {
    const at = Date.now()
    uploadStatusStore$.assign({ lastCompletion: { ...completion, at }, clock: at })
  },

  dismissCompletion: () => uploadStatusStore$.completionDismissedAt.set(Date.now()),

  setQueueEnabled: (enabled: boolean) => uploadStatusStore$.queueEnabled.set(enabled),

  /** Advance the clock so a held completion can expire back to idle. */
  tick: () => uploadStatusStore$.clock.set(Date.now()),

  setBannerHeight: (height: number) => uploadStatusStore$.bannerHeight.set(height),

  /** Register how one upload system restarts its work; returns an unregister. */
  registerRetryHandler: (key: string, handler: RetryHandler) => {
    retryHandlers.set(key, handler)
    return () => {
      if (retryHandlers.get(key) === handler) retryHandlers.delete(key)
    }
  },
}

/** Kick every upload system now. Each handler is idempotent and lock-gated. */
export function retryPendingUploads() {
  telemetry.breadcrumb('upload:banner:retry', { handlers: retryHandlers.size })
  for (const [key, handler] of retryHandlers) {
    Promise.resolve()
      .then(handler)
      .catch((error) => {
        telemetry.warn('upload:banner:retry_failed', 'Upload retry failed', {
          source: key,
          error: String(error),
        })
      })
  }
}
