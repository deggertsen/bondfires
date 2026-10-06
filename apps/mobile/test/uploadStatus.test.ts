import { describe, expect, it } from 'vitest'
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

describe('deriveUploadStatus', () => {
  it('is idle with nothing in flight', () => {
    expect(deriveUploadStatus(input())).toEqual({ kind: 'idle' })
  })

  it('shows a segmented job as indeterminate uploading', () => {
    expect(deriveUploadStatus(input({ segmentJobs: [segment()] }))).toEqual({
      kind: 'uploading',
      count: 1,
      subject: 'response',
    })
  })

  it('shows the offline pause (never the error copy) when a job waits without a connection', () => {
    const state = deriveUploadStatus(input({ segmentJobs: [segment()], isOnline: false }))
    expect(state).toEqual({ kind: 'paused', count: 1, subject: 'response', reason: 'offline' })
    if (state.kind !== 'paused') throw new Error('expected paused')
    expect(describeUploadStatus(state).title).toBe('Waiting for a connection')
  })

  it('treats a paused segmented job as retrying', () => {
    expect(deriveUploadStatus(input({ segmentJobs: [segment({ paused: true })] }))).toMatchObject({
      kind: 'paused',
      reason: 'retrying',
    })
  })

  it('keeps uploading while at least one job is still making progress', () => {
    const state = deriveUploadStatus(
      input({ segmentJobs: [segment({ localId: 'a', paused: true }), segment({ localId: 'b' })] }),
    )
    expect(state).toMatchObject({ kind: 'uploading', count: 2 })
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

  it('does not resurface a completion the user dismissed', () => {
    const lastCompletion = { subject: 'response' as const, at: now - 100 }
    expect(deriveUploadStatus(input({ lastCompletion }))).toMatchObject({ kind: 'completed' })
    expect(deriveUploadStatus(input({ lastCompletion, completionDismissedAt: now - 50 }))).toEqual({
      kind: 'idle',
    })
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
