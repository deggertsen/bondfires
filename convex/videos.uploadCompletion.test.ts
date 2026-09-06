import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'

vi.mock('./auth', () => ({ auth: { getUserId: vi.fn().mockResolvedValue('owner') } }))

import {
  getUploadCompletion,
  markMuxAssetCreated,
  monitorUploadCompletion,
  recoverUploadCompletion,
} from './videos'

function handler<Context, Args, Result>(fn: unknown) {
  return (fn as { _handler: (ctx: Context, args: Args) => Promise<Result> })._handler
}
const monitor = handler<MutationCtx, { uploadId: string }, void>(monitorUploadCompletion)
const status = handler<QueryCtx, { uploadId: string }, { isReady: boolean }>(getUploadCompletion)
const created = handler<MutationCtx, { uploadId: string; assetId: string }, unknown>(
  markMuxAssetCreated,
)
const recover = handler<ActionCtx, { uploadId: string; startedAt: number; attempt: number }, void>(
  recoverUploadCompletion,
)

function recordContext(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: 'record',
    userId: 'owner',
    videoStatus: 'processing',
    muxUploadId: 'upload',
    ...overrides,
  }
  const query = { withIndex: vi.fn(), first: vi.fn().mockResolvedValue(doc) }
  query.withIndex.mockReturnValue(query)
  const ctx = {
    db: {
      query: vi.fn().mockReturnValue(query),
      patch: vi.fn(async (_id, patch) => Object.assign(doc, patch)),
    },
    scheduler: { runAfter: vi.fn() },
  }
  return {
    ctx: ctx as unknown as MutationCtx,
    doc,
    schedule: ctx.scheduler.runAfter,
    patch: ctx.db.patch,
  }
}

describe('upload completion recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  it('deduplicates repeated monitor requests and schedules the first check after 30 seconds', async () => {
    const { ctx, schedule } = recordContext()
    await monitor(ctx, { uploadId: 'upload' })
    await monitor(ctx, { uploadId: 'upload' })
    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule.mock.calls[0][0]).toBe(30_000)
  })
  it('rejects watching or scheduling another user’s upload', async () => {
    const { ctx, schedule } = recordContext({ userId: 'someone-else' })
    await expect(monitor(ctx, { uploadId: 'upload' })).rejects.toThrow('Upload not found')
    await expect(status(ctx, { uploadId: 'upload' })).rejects.toThrow('Upload not found')
    expect(schedule).not.toHaveBeenCalled()
  })
  it('does no recovery work for an already-ready video', async () => {
    const { ctx, schedule } = recordContext({ videoStatus: 'ready', muxPlaybackId: 'playback' })
    await monitor(ctx, { uploadId: 'upload' })
    expect(schedule).not.toHaveBeenCalled()
  })
  it('does not regress ready state on late or duplicate asset-created events', async () => {
    const { ctx, patch } = recordContext({
      videoStatus: 'ready',
      muxPlaybackId: 'playback',
      muxAssetId: 'asset',
    })
    await created(ctx, { uploadId: 'upload', assetId: 'asset' })
    await created(ctx, { uploadId: 'upload', assetId: 'different-asset' })
    expect(patch).not.toHaveBeenCalled()
  })
  it('stops obsolete jobs and jobs already completed by a webhook before contacting Mux', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const runAfter = vi.fn()
    const runQuery = vi.fn().mockResolvedValue({ startedAt: 1, isReady: true })
    const ctx = { runQuery, scheduler: { runAfter } } as unknown as ActionCtx
    await recover(ctx, { uploadId: 'upload', startedAt: 1, attempt: 0 })
    runQuery.mockResolvedValue({ startedAt: 2, isReady: false })
    await recover(ctx, { uploadId: 'upload', startedAt: 1, attempt: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect(runAfter).not.toHaveBeenCalled()
  })
  it('recovers a missed ready webhook from Mux and stops scheduling checks', async () => {
    vi.stubEnv('MUX_TOKEN_ID', 'test')
    vi.stubEnv('MUX_TOKEN_SECRET', 'test')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { asset_id: 'asset', status: 'asset_created' } })),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                id: 'asset',
                status: 'ready',
                playback_ids: [{ id: 'playback', policy: 'public' }],
                duration: 3,
              },
            }),
          ),
        ),
    )
    const runAfter = vi.fn()
    const runMutation = vi.fn().mockResolvedValue({ updated: true })
    const ctx = {
      runQuery: vi.fn().mockResolvedValue({ startedAt: 1, isReady: false, isFailed: false }),
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx
    await recover(ctx, { uploadId: 'upload', startedAt: 1, attempt: 0 })
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1][1]).toMatchObject({
      uploadId: 'upload',
      assetId: 'asset',
      playbackId: 'playback',
      assetStatus: 'ready',
    })
    expect(runAfter).not.toHaveBeenCalled()
  })
  it('bounds fallback checks even when Mux is unavailable', async () => {
    vi.stubEnv('MUX_TOKEN_ID', 'test')
    vi.stubEnv('MUX_TOKEN_SECRET', 'test')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const runAfter = vi.fn()
    const ctx = {
      runQuery: vi.fn().mockResolvedValue({ startedAt: 1, isReady: false, isFailed: false }),
      scheduler: { runAfter },
    } as unknown as ActionCtx
    for (let attempt = 0; attempt < 5; attempt++) {
      await recover(ctx, { uploadId: 'upload', startedAt: 1, attempt })
    }
    expect(runAfter.mock.calls.map(([delay]) => delay)).toEqual([60_000, 120_000, 240_000, 240_000])
  })
})
