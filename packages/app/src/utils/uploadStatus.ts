/**
 * Pure read model for the app-wide upload status banner
 * (docs/plans/2026-09-29-upload-status-banner.md).
 *
 * Segmented R2 capture is the only upload system: jobs are journal-driven with
 * no progress %, re-reported from the durable journal on each upload tick.
 * Kept free of React/native imports so it is unit-testable.
 */

export const UPLOAD_COMPLETION_HOLD_MS = 5_000

/** What kind of video is in flight; decides "response" vs "Bondfire" copy. */
export type UploadSubject = 'response' | 'bondfire' | 'recording'

/** Why the latest upload pass failed. User-facing copy is derived from this, never from raw errors. */
export type UploadFailureKind = 'unavailable' | 'timeout' | 'unauthorized' | 'server'

/** Acknowledgement for a Retry tap. Cleared by the store once it has been readable. */
export type UploadRetryNotice = 'started' | 'busy' | 'skipped'

/** One segmented capture job as reported by the segment upload loop. */
export interface SegmentJobStatus {
  localId: string
  isResponse: boolean
  /** Bondfire to open once finished (parent for responses, own row for sparks). */
  bondfireId?: string
  /** True after an upload pass failed, until a later pass makes progress. */
  paused: boolean
  /** Set with `paused` and cleared on the next segment that actually uploads. */
  failure?: UploadFailureKind
}

export interface UploadCompletion {
  subject: UploadSubject
  bondfireId?: string
  at: number
}

export type UploadStatusState =
  | { kind: 'idle' }
  | {
      kind: 'uploading'
      count: number
      subject: UploadSubject
    }
  | {
      kind: 'paused'
      count: number
      subject: UploadSubject
      reason: 'offline' | 'retrying'
      /** Present while a Retry tap is being acknowledged. */
      notice?: UploadRetryNotice
      /** Why the latest pass failed, when the queue reported one. */
      failure?: UploadFailureKind
    }
  | {
      kind: 'completed'
      subject: UploadSubject
      bondfireId?: string
      expiresAt: number
    }

export interface UploadStatusInput {
  segmentJobs: SegmentJobStatus[]
  isOnline: boolean
  /** Most recent segmented completion (in-memory only, never persisted). */
  lastCompletion: UploadCompletion | null
  /** Completions at or before this time were dismissed by the user. */
  completionDismissedAt: number
  /** Set while Retry now should visibly acknowledge the tap. */
  retryNotice?: UploadRetryNotice | null
  now: number
}

function sharedSubject(jobs: SegmentJobStatus[]): UploadSubject {
  return jobs.length === 1 ? (jobs[0].isResponse ? 'response' : 'bondfire') : 'recording'
}

const FAILURE_PRIORITY: UploadFailureKind[] = ['unavailable', 'unauthorized', 'timeout', 'server']

function dominantFailure(jobs: SegmentJobStatus[]): UploadFailureKind | undefined {
  const present = new Set(jobs.flatMap((job) => (job.failure ? [job.failure] : [])))
  return FAILURE_PRIORITY.find((kind) => present.has(kind))
}

function pausedState(
  input: UploadStatusInput,
  jobs: SegmentJobStatus[],
  reason: 'offline' | 'retrying',
): Extract<UploadStatusState, { kind: 'paused' }> {
  const failure = reason === 'retrying' ? dominantFailure(jobs) : undefined
  const notice = input.retryNotice || undefined
  return {
    kind: 'paused',
    count: jobs.length,
    subject: sharedSubject(jobs),
    reason,
    ...(failure ? { failure } : {}),
    ...(notice ? { notice } : {}),
  }
}

/** Priority: paused > uploading > completed (held ~5s) > idle. */
export function deriveUploadStatus(input: UploadStatusInput): UploadStatusState {
  const jobs = input.segmentJobs
  const uploading = jobs.filter((job) => !job.paused)

  if (jobs.length > 0) {
    if (!input.isOnline) return pausedState(input, jobs, 'offline')
    if (uploading.length === 0) return pausedState(input, jobs, 'retrying')
    return { kind: 'uploading', count: jobs.length, subject: sharedSubject(jobs) }
  }

  const completion = input.lastCompletion
  if (
    completion &&
    completion.at > input.completionDismissedAt &&
    input.now < completion.at + UPLOAD_COMPLETION_HOLD_MS
  ) {
    return {
      kind: 'completed',
      subject: completion.subject,
      bondfireId: completion.bondfireId,
      expiresAt: completion.at + UPLOAD_COMPLETION_HOLD_MS,
    }
  }

  return { kind: 'idle' }
}

export interface UploadStatusCopy {
  title: string
  message: string
  /** Label for the trailing button; none while an upload is simply running. */
  actionLabel?: string
}

function noun(subject: UploadSubject): string {
  switch (subject) {
    case 'response':
      return 'response'
    case 'bondfire':
      return 'Bondfire'
    case 'recording':
      return 'recording'
  }
}

function offlineMessage(state: Extract<UploadStatusState, { kind: 'paused' }>): string {
  return state.count > 1
    ? 'Your recordings are saved on this phone and will upload automatically.'
    : `Your ${noun(state.subject)} is saved on this phone and will upload automatically.`
}

function failureMessage(failure: UploadFailureKind | undefined): string {
  switch (failure) {
    case 'unavailable':
      return 'Server unavailable, still saved on this phone.'
    case 'timeout':
      return 'The connection timed out, still saved on this phone.'
    case 'unauthorized':
      return "The upload couldn't be authorized, still saved on this phone."
    case 'server':
      return 'The server rejected the upload, still saved on this phone.'
    default:
      return 'Saved on this phone · retrying automatically'
  }
}

function pausedMessage(state: Extract<UploadStatusState, { kind: 'paused' }>): string {
  return state.reason === 'offline' ? offlineMessage(state) : failureMessage(state.failure)
}

/** Banner copy for a non-idle state. */
export function describeUploadStatus(
  state: Exclude<UploadStatusState, { kind: 'idle' }>,
): UploadStatusCopy {
  switch (state.kind) {
    case 'uploading':
      return {
        title:
          state.count > 1
            ? `Uploading ${state.count} recordings`
            : `Uploading your ${noun(state.subject)}`,
        message: "Keep using the app — we'll finish in the background.",
      }
    case 'paused': {
      const message = pausedMessage(state)
      if (state.notice === 'started') {
        return { title: 'Retrying now…', message, actionLabel: 'Retrying…' }
      }
      if (state.notice === 'busy') {
        return { title: 'Retry already in progress', message, actionLabel: 'Retrying…' }
      }
      if (state.notice === 'skipped') {
        return { title: "Couldn't start retry", message, actionLabel: 'Retry now' }
      }
      if (state.reason === 'offline') {
        return { title: 'Waiting for a connection', message, actionLabel: 'Retry' }
      }
      return { title: 'Retrying upload', message, actionLabel: 'Retry now' }
    }
    case 'completed':
      return {
        title: `Your ${noun(state.subject)} is live`,
        message: 'Your video finished uploading.',
        actionLabel: state.bondfireId ? 'View' : undefined,
      }
  }
}
