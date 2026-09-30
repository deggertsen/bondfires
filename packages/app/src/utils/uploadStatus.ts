/**
 * Pure read model for the app-wide upload status banner
 * (docs/plans/2026-09-29-upload-status-banner.md).
 *
 * Normalizes the two upload systems that coexist during the Mux retirement:
 * segmented R2 capture (journal-driven, no progress %) and the legacy MMKV
 * queue (legacy + live_backup tasks, with progress and retry attempts).
 * Kept free of React/native imports so it is unit-testable.
 */

import type { UploadTask } from '../store/uploadQueue.store'

export const UPLOAD_COMPLETION_HOLD_MS = 5_000
export const UPLOAD_MAX_ATTEMPTS = 5

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
      /** 0–100, only when a single legacy task reports it. */
      progress?: number
    }
  | {
      kind: 'paused'
      count: number
      subject: UploadSubject
      reason: 'offline' | 'retrying'
      /** 1-based attempt about to run, when the legacy queue knows it. */
      attempt?: number
    }
  | {
      kind: 'failed'
      count: number
      subject: UploadSubject
      /** When the most recent task gave up; lets a new failure outrank a hide. */
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
  /** Legacy queue tasks; ignored unless `queueEnabled`. */
  tasks: UploadTask[]
  /** False in segmented builds, where the legacy queue never runs. */
  queueEnabled: boolean
  isOnline: boolean
  /** Most recent segmented completion (in-memory only, never persisted). */
  lastCompletion: UploadCompletion | null
  /** Completions at or before this time were dismissed by the user. */
  completionDismissedAt: number
  now: number
}

type Job = {
  subject: UploadSubject
  state: 'uploading' | 'retrying' | 'failed'
  progress?: number
  attempt?: number
  failedAt?: number
}

function taskSubject(task: UploadTask): UploadSubject {
  if (task.taskType === 'live_backup') return 'recording'
  return task.isResponse ? 'response' : 'bondfire'
}

function taskBondfireId(task: UploadTask): string | undefined {
  if (task.isResponse) return task.bondfireId
  if (task.muxUpload?.recordType === 'bondfire') return task.muxUpload.recordId
  return task.recordType === 'bondfire' ? task.recordId : undefined
}

function taskJob(task: UploadTask): Job | null {
  switch (task.status) {
    case 'failed':
      return {
        subject: taskSubject(task),
        state: 'failed',
        failedAt: task.lastAttemptAt ?? task.updatedAt ?? task.createdAt,
      }
    case 'pending':
      // A pending task with prior attempts is sitting out an exponential backoff.
      if (task.attemptCount > 0) {
        return {
          subject: taskSubject(task),
          state: 'retrying',
          attempt: Math.min(task.attemptCount + 1, UPLOAD_MAX_ATTEMPTS),
        }
      }
      return { subject: taskSubject(task), state: 'uploading' }
    case 'processing':
    case 'uploading':
      return { subject: taskSubject(task), state: 'uploading', progress: task.progress }
    default:
      return null
  }
}

function sharedSubject(jobs: Job[]): UploadSubject {
  return jobs.length === 1 ? jobs[0].subject : 'recording'
}

function latestCompletion(input: UploadStatusInput): UploadCompletion | null {
  let latest = input.lastCompletion
  if (input.queueEnabled) {
    for (const task of input.tasks) {
      if (task.status !== 'completed' || task.completedAt === undefined) continue
      if (!latest || task.completedAt > latest.at) {
        latest = {
          subject: taskSubject(task),
          bondfireId: taskBondfireId(task),
          at: task.completedAt,
        }
      }
    }
  }
  return latest
}

/** Priority: failed > paused > uploading > completed (held ~5s) > idle. */
export function deriveUploadStatus(input: UploadStatusInput): UploadStatusState {
  const jobs: Job[] = input.segmentJobs.map((job) => ({
    subject: job.isResponse ? 'response' : 'bondfire',
    state: job.paused ? 'retrying' : 'uploading',
  }))
  if (input.queueEnabled) {
    for (const task of input.tasks) {
      const job = taskJob(task)
      if (job) jobs.push(job)
    }
  }

  const failed = jobs.filter((job) => job.state === 'failed')
  if (failed.length > 0) {
    return {
      kind: 'failed',
      count: failed.length,
      subject: sharedSubject(failed),
      failedAt: Math.max(...failed.map((job) => job.failedAt ?? 0)),
    }
  }

  if (jobs.length > 0) {
    if (!input.isOnline) {
      return { kind: 'paused', count: jobs.length, subject: sharedSubject(jobs), reason: 'offline' }
    }
    const retrying = jobs.filter((job) => job.state === 'retrying')
    if (retrying.length > 0) {
      const attempts = retrying.flatMap((job) => (job.attempt ? [job.attempt] : []))
      return {
        kind: 'paused',
        count: jobs.length,
        subject: sharedSubject(jobs),
        reason: 'retrying',
        attempt: attempts.length > 0 ? Math.max(...attempts) : undefined,
      }
    }
    const progress = jobs.length === 1 ? jobs[0].progress : undefined
    return {
      kind: 'uploading',
      count: jobs.length,
      subject: sharedSubject(jobs),
      progress: progress && progress > 0 ? Math.min(100, Math.round(progress)) : undefined,
    }
  }

  const completion = latestCompletion(input)
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
        message: state.attempt
          ? `Attempt ${state.attempt} of ${UPLOAD_MAX_ATTEMPTS} · saved on this phone`
          : 'Saved on this phone · retrying automatically',
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
