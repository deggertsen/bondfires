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

/** One segmented capture job as reported by the segment upload loop. */
export interface SegmentJobStatus {
  localId: string
  isResponse: boolean
  /** Bondfire to open once finished (parent for responses, own row for sparks). */
  bondfireId?: string
  /** True after an upload pass failed, until a later pass makes progress. */
  paused: boolean
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
    }
  | {
      kind: 'failed'
      count: number
      subject: UploadSubject
      /** When the most recent job gave up; lets a new failure outrank a hide. */
      failedAt: number
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
  now: number
}

function sharedSubject(jobs: SegmentJobStatus[]): UploadSubject {
  return jobs.length === 1 ? (jobs[0].isResponse ? 'response' : 'bondfire') : 'recording'
}

/** Priority: failed > paused > uploading > completed (held ~5s) > idle. */
export function deriveUploadStatus(input: UploadStatusInput): UploadStatusState {
  const jobs = input.segmentJobs
  const uploading = jobs.filter((job) => !job.paused)

  if (jobs.length > 0) {
    if (!input.isOnline) {
      return { kind: 'paused', count: jobs.length, subject: sharedSubject(jobs), reason: 'offline' }
    }
    if (uploading.length === 0) {
      return {
        kind: 'paused',
        count: jobs.length,
        subject: sharedSubject(jobs),
        reason: 'retrying',
      }
    }
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

/**
 * Whether a banner the user swiped away should stay hidden. A hide lasts for
 * the app session and never stops the upload. The one exception is a failure
 * that happens after the hide: that upload can't finish without the user.
 */
export function isUploadStatusHidden(state: UploadStatusState, hiddenAt: number | null): boolean {
  if (hiddenAt === null) return false
  return !(state.kind === 'failed' && state.failedAt > hiddenAt)
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
    case 'paused':
      if (state.reason === 'offline') {
        return {
          title: 'Waiting for a connection',
          message:
            state.count > 1
              ? 'Your recordings are saved on this phone and will upload automatically.'
              : `Your ${noun(state.subject)} is saved on this phone and will upload automatically.`,
          actionLabel: 'Retry',
        }
      }
      return {
        title: 'Upload paused — retrying',
        message: 'Saved on this phone · retrying automatically',
        actionLabel: 'Retry now',
      }
    case 'failed':
      return {
        title: "Upload didn't finish",
        message:
          state.count > 1
            ? 'Your videos are still saved on this phone.'
            : 'Your video is still saved on this phone.',
        actionLabel: 'Try again',
      }
    case 'completed':
      return {
        title: `Your ${noun(state.subject)} is live`,
        message: 'Your video finished uploading.',
        actionLabel: state.bondfireId ? 'View' : undefined,
      }
  }
}
