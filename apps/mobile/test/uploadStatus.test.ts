import { describe, expect, it } from 'vitest'
import type { UploadTask } from '../../../packages/app/src/store/uploadQueue.store'
import {
  deriveUploadStatus,
  describeUploadStatus,
  type SegmentJobStatus,
  UPLOAD_COMPLETION_HOLD_MS,
  type UploadStatusInput,
} from '../../../packages/app/src/utils/uploadStatus'

const now = 1_000_000

function input(overrides: Partial<UploadStatusInput> = {}): UploadStatusInput {
  return {
    segmentJobs: [],
    tasks: [],
    queueEnabled: true,
    isOnline: true,
    lastCompletion: null,
    completionDismissedAt: 0,
    now,
    ...overrides,
  }
}

function segment(overrides: Partial<SegmentJobStatus> = {}): SegmentJobStatus {
  return { localId: 'local', isResponse: true, bondfireId: 'parent', paused: false, ...overrides }
}

function task(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id: 'task',
    videoFilePath: 'file:///video.mp4',
    isResponse: false,
    status: 'uploading',
    attemptCount: 0,
    createdAt: now - 1000,
    ...overrides,
  }
}

describe('deriveUploadStatus', () => {
  it('is idle with nothing in flight', () => {
    expect(deriveUploadStatus(input())).toEqual({ kind: 'idle' })
  })

  it('shows a segmented job as indeterminate uploading', () => {
    expect(deriveUploadStatus(input({ segmentJobs: [segment()] }))).toEqual({
      kind: 'uploading',
      count: 1,
      subject: 'response',
      progress: undefined,
    })
  })

  it('shows progress only for a single legacy task', () => {
    const single = deriveUploadStatus(input({ tasks: [task({ progress: 61.6 })] }))
    expect(single).toMatchObject({ kind: 'uploading', subject: 'bondfire', progress: 62 })

    const mixed = deriveUploadStatus(
      input({ segmentJobs: [segment()], tasks: [task({ progress: 40 })] }),
    )
    expect(mixed).toEqual({
      kind: 'uploading',
      count: 2,
      subject: 'recording',
      progress: undefined,
    })
  })

  it('shows the offline pause (never the error copy) when a job waits without a connection', () => {
    const state = deriveUploadStatus(input({ segmentJobs: [segment()], isOnline: false }))
    expect(state).toEqual({ kind: 'paused', count: 1, subject: 'response', reason: 'offline' })
    if (state.kind !== 'paused') throw new Error('expected paused')
    expect(describeUploadStatus(state).title).toBe('Waiting for a connection')
  })

  it('names the retry attempt for a legacy task in backoff', () => {
    const state = deriveUploadStatus(
      input({ tasks: [task({ status: 'pending', attemptCount: 2 })] }),
    )
    expect(state).toMatchObject({ kind: 'paused', reason: 'retrying', attempt: 3 })
    if (state.kind !== 'paused') throw new Error('expected paused')
    expect(describeUploadStatus(state).message).toBe('Attempt 3 of 5 · saved on this phone')
  })

  it('treats a paused segmented job as retrying with no attempt count', () => {
    expect(deriveUploadStatus(input({ segmentJobs: [segment({ paused: true })] }))).toMatchObject({
      kind: 'paused',
      reason: 'retrying',
      attempt: undefined,
    })
  })

  it('prioritizes failed over paused over uploading', () => {
    const tasks = [
      task({ id: 'a', status: 'failed', attemptCount: 5 }),
      task({ id: 'b', status: 'pending', attemptCount: 1 }),
    ]
    expect(deriveUploadStatus(input({ tasks, segmentJobs: [segment()] }))).toEqual({
      kind: 'failed',
      count: 1,
      subject: 'bondfire',
    })
    expect(
      deriveUploadStatus(input({ tasks: [tasks[1]], segmentJobs: [segment()] })),
    ).toMatchObject({ kind: 'paused', count: 2, reason: 'retrying' })
  })

  it('counts multiple jobs rather than picking one label', () => {
    const state = deriveUploadStatus(
      input({
        segmentJobs: [segment({ localId: 'a' }), segment({ localId: 'b', isResponse: false })],
      }),
    )
    expect(state).toMatchObject({ kind: 'uploading', count: 2, subject: 'recording' })
    if (state.kind !== 'uploading') throw new Error('expected uploading')
    expect(describeUploadStatus(state).title).toBe('Uploading 2 recordings')
  })

  it('ignores legacy queue tasks when the queue does not run in this build', () => {
    expect(
      deriveUploadStatus(input({ queueEnabled: false, tasks: [task({ status: 'pending' })] })),
    ).toEqual({ kind: 'idle' })
  })

  it('labels live-backup recovery as a recording', () => {
    expect(
      deriveUploadStatus(input({ tasks: [task({ taskType: 'live_backup', status: 'pending' })] })),
    ).toMatchObject({ kind: 'uploading', subject: 'recording' })
  })

  it('holds a completion briefly, then returns to idle', () => {
    const lastCompletion = { subject: 'response' as const, bondfireId: 'parent', at: now - 1000 }
    const held = deriveUploadStatus(input({ lastCompletion }))
    expect(held).toEqual({
      kind: 'completed',
      subject: 'response',
      bondfireId: 'parent',
      expiresAt: now - 1000 + UPLOAD_COMPLETION_HOLD_MS,
    })
    if (held.kind !== 'completed') throw new Error('expected completed')
    expect(describeUploadStatus(held)).toEqual({
      title: 'Your response is live',
      message: 'Your video finished uploading.',
      actionLabel: 'View',
    })
    expect(
      deriveUploadStatus(input({ lastCompletion, now: now + UPLOAD_COMPLETION_HOLD_MS })),
    ).toEqual({ kind: 'idle' })
  })

  it('does not resurface an old queue completion after a relaunch, or one the user dismissed', () => {
    const completedTask = task({ status: 'completed', completedAt: now - 60_000 })
    expect(deriveUploadStatus(input({ tasks: [completedTask] }))).toEqual({ kind: 'idle' })

    const fresh = task({
      status: 'completed',
      completedAt: now - 500,
      muxUpload: {
        uploadId: 'u',
        uploadUrl: 'https://mux',
        recordId: 'spark',
        recordType: 'bondfire',
      },
    })
    expect(deriveUploadStatus(input({ tasks: [fresh] }))).toMatchObject({
      kind: 'completed',
      subject: 'bondfire',
      bondfireId: 'spark',
    })
    expect(deriveUploadStatus(input({ tasks: [fresh], completionDismissedAt: now - 100 }))).toEqual(
      { kind: 'idle' },
    )
  })

  it('prefers in-flight work over a held completion', () => {
    expect(
      deriveUploadStatus(
        input({
          segmentJobs: [segment()],
          lastCompletion: { subject: 'response', at: now - 100 },
        }),
      ),
    ).toMatchObject({ kind: 'uploading' })
  })
})
