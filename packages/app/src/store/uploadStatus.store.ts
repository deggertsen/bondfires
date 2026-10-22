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
  /** Visible acknowledgement of a Retry tap, owned by the retry lifecycle below. */
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

type RetryHandler = () => UploadRetryOutcome | Promise<UploadRetryOutcome>
const retryHandlers = new Map<string, RetryHandler>()

type RetryAttempt = { pending: boolean; visibleUntil: number }
let retryAttempt: RetryAttempt | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined

function clearRetryNotice() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  retryAttempt = null
  uploadStatusStore$.retryNotice.set(null)
}

function showRetryNotice(attempt: RetryAttempt, notice: UploadRetryNotice) {
  attempt.visibleUntil = Date.now() + (notice === 'started' ? 1200 : 3200)
  uploadStatusStore$.retryNotice.set(notice)
}

export const uploadStatusActions = {
  setSegmentJobs: (jobs: SegmentJobStatus[]) => {
    // Completion, sign-out and observer teardown end this queue's feedback.
    // A late handler result must not restore it for a different queue/account.
    if (jobs.length === 0) clearRetryNotice()
    uploadStatusStore$.segmentJobs.set(jobs)
  },

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

  /** Register how one upload system restarts its work; returns an unregister. */
  registerRetryHandler: (key: string, handler: RetryHandler) => {
    retryHandlers.set(key, handler)
    return () => {
      if (retryHandlers.get(key) === handler) retryHandlers.delete(key)
    }
  },
}

/** Acknowledge every tap, but keep following the original pass on repeated taps. */
export async function retryPendingUploads(): Promise<UploadRetryOutcome> {
  telemetry.breadcrumb('upload:banner:retry', { handlers: retryHandlers.size })
  if (retryAttempt?.pending) {
    showRetryNotice(retryAttempt, 'busy')
    return 'busy'
  }

  clearRetryNotice()
  const attempt: RetryAttempt = { pending: true, visibleUntil: 0 }
  retryAttempt = attempt
  showRetryNotice(attempt, 'started')
  const outcome = await runRetryHandlers()
  if (retryAttempt !== attempt) return outcome

  attempt.pending = false
  if (outcome !== 'started') showRetryNotice(attempt, outcome)
  // Keep fast failures readable and slow passes acknowledged until they settle.
  // A newer tap or a cleared queue cancels this timer and invalidates the attempt.
  retryTimer = setTimeout(clearRetryNotice, Math.max(0, attempt.visibleUntil - Date.now()))
  return outcome
}

/** Each upload system is independently lock-gated, including its automatic retries. */
async function runRetryHandlers(): Promise<UploadRetryOutcome> {
  const results = await Promise.all(
    [...retryHandlers.entries()].map(async ([key, handler]) => {
      try {
        return await handler()
      } catch {
        telemetry.warn('upload:banner:retry_failed', 'Upload retry failed', {
          source: key,
        })
        return 'skipped' as const
      }
    }),
  )
  if (results.includes('started')) return 'started'
  if (results.includes('busy')) return 'busy'
  return 'skipped'
}
