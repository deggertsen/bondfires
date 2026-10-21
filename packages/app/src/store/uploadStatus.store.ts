import { observable } from '@legendapp/state'
import { telemetry } from '../services/telemetry'
import {
  deriveUploadStatus,
  type SegmentJobStatus,
  type UploadCompletion,
  type UploadRetryNotice,
  type UploadStatusState,
} from '../utils/uploadStatus'
import { uiStore$ } from './ui.store'

// Transient (not persisted): segmented jobs are re-reported from the durable
// journal within one upload tick.
interface UploadStatusStoreState {
  segmentJobs: SegmentJobStatus[]
  lastCompletion: UploadCompletion | null
  completionDismissedAt: number
  /** Set when the user swipes the banner away; cleared only by an app restart. */
  hiddenAt: number | null
  /** Re-evaluation clock for the completion hold. */
  clock: number
  /** Measured height of the banner, 0 while hidden; offsets toasts below it. */
  bannerHeight: number
  /** Visible acknowledgement of a Retry tap. The banner clears it. */
  retryNotice: UploadRetryNotice | null
}

export const uploadStatusStore$ = observable<UploadStatusStoreState>({
  segmentJobs: [],
  lastCompletion: null,
  completionDismissedAt: 0,
  hiddenAt: null,
  clock: Date.now(),
  bannerHeight: 0,
  retryNotice: null,
})

export const uploadStatus$ = observable<UploadStatusState>(() =>
  deriveUploadStatus({
    segmentJobs: uploadStatusStore$.segmentJobs.get(),
    isOnline: uiStore$.isOnline.get(),
    lastCompletion: uploadStatusStore$.lastCompletion.get(),
    completionDismissedAt: uploadStatusStore$.completionDismissedAt.get(),
    retryNotice: uploadStatusStore$.retryNotice.get(),
    now: uploadStatusStore$.clock.get(),
  }),
)

export type UploadRetryOutcome = 'started' | 'busy' | 'skipped'

type RetryHandler = () => undefined | Promise<UploadRetryOutcome | undefined>
const retryHandlers = new Map<string, RetryHandler>()

export const uploadStatusActions = {
  setSegmentJobs: (jobs: SegmentJobStatus[]) => uploadStatusStore$.segmentJobs.set(jobs),

  recordCompletion: (completion: Omit<UploadCompletion, 'at'>) => {
    const at = Date.now()
    uploadStatusStore$.assign({ lastCompletion: { ...completion, at }, clock: at })
  },

  dismissCompletion: () => uploadStatusStore$.completionDismissedAt.set(Date.now()),

  /** Hide the banner for this app session. Uploads keep running. */
  hideForSession: () => uploadStatusStore$.hiddenAt.set(Date.now()),

  /** Advance the clock so a held completion can expire back to idle. */
  tick: () => uploadStatusStore$.clock.set(Date.now()),

  setBannerHeight: (height: number) => uploadStatusStore$.bannerHeight.set(height),

  /** Show that Retry now was tapped. `busy` means a pass was already running. */
  showRetryNotice: (notice: UploadRetryNotice) => uploadStatusStore$.retryNotice.set(notice),

  clearRetryNotice: () => uploadStatusStore$.retryNotice.set(null),

  /** Register how one upload system restarts its work; returns an unregister. */
  registerRetryHandler: (key: string, handler: RetryHandler) => {
    retryHandlers.set(key, handler)
    return () => {
      if (retryHandlers.get(key) === handler) retryHandlers.delete(key)
    }
  },
}

/** Kick every upload system now. Each handler is idempotent and lock-gated. */
export async function retryPendingUploads(): Promise<UploadRetryOutcome> {
  telemetry.breadcrumb('upload:banner:retry', { handlers: retryHandlers.size })
  if (retryHandlers.size === 0) return 'skipped'
  const results = await Promise.all(
    [...retryHandlers.entries()].map(async ([key, handler]) => {
      try {
        return (await handler()) ?? 'started'
      } catch (error) {
        telemetry.warn('upload:banner:retry_failed', 'Upload retry failed', {
          source: key,
          error: String(error),
        })
        return 'skipped' as const
      }
    }),
  )
  if (results.includes('started')) return 'started'
  if (results.includes('busy')) return 'busy'
  return 'skipped'
}
