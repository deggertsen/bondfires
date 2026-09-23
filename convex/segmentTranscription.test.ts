/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { cuesToVtt, speechCues, transcriptionWindow } from '../packages/media/src/transcription'
import { internal } from './_generated/api'
import schema from './schema'
import { enqueueTranscription } from './segmentTranscription'

const modules = import.meta.glob('./**/*.ts')
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://ideal-akita-27.convex.cloud')
  vi.stubEnv('SEGMENT_MEDIA_ENABLED', '1')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
async function setup() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { gender: 'other' })
    const recordingId = await ctx.db.insert('segmentRecordings', {
      userId,
      localId: 'caption-test',
      status: 'ready',
      segmentCount: 8,
      duration: 32,
      finalCount: 8,
      maxDuration: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const bondfireId = await ctx.db.insert('bondfires', {
      userId,
      segmentRecordingId: recordingId,
      videoStatus: 'ready',
      videoCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await ctx.db.patch(recordingId, { bondfireId })
    for (let index = 0; index < 8; index++)
      await ctx.db.insert('mediaSegments', {
        recordingId,
        index,
        duration: 4,
        size: 1000,
        checksum: 'a'.repeat(64),
      })
    await enqueueTranscription(ctx, recordingId)
    return { userId, recordingId, bondfireId }
  })
  return { t, ...ids }
}
describe('R2 transcription jobs', () => {
  it('claims once, resumes after lease expiry, and rejects stale completion', async () => {
    const { t, recordingId } = await setup()
    const first = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(first)
    expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
    await t.run((ctx) => ctx.db.patch(first.jobId, { leaseUntil: 0 }))
    const newer = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(newer)
    // Force a distinct lease even when the test clock resolves within one millisecond.
    await t.run((ctx) => ctx.db.patch(first.jobId, { leaseUntil: first.leaseUntil + 1 }))
    expect(
      await t.mutation(internal.segmentTranscription.completeChunk, {
        recordingId,
        jobId: first.jobId,
        cursor: 0,
        leaseUntil: first.leaseUntil,
        nextIndex: 6,
        text: 'stale',
        vtt: 'stale',
      }),
    ).toBe(false)
  })
  it('appends captions once, publishes only on completion, and queues summaries', async () => {
    const { t, recordingId, bondfireId, userId } = await setup()
    const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(claim)
    const args = {
      recordingId,
      jobId: claim.jobId,
      cursor: 0,
      leaseUntil: claim.leaseUntil,
      nextIndex: claim.nextIndex,
      text: 'The first sentence.',
      vtt: '00:00:00.000 --> 00:00:02.000\nThe first sentence.\n\n',
    }
    expect(await t.mutation(internal.segmentTranscription.completeChunk, args)).toBe(true)
    expect(await t.mutation(internal.segmentTranscription.completeChunk, args)).toBe(false)
    expect(await t.query(internal.segmentMedia.captions, { recordingId, userId })).toEqual({
      captionsVtt: null,
    })
    const next = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(next)
    await t.mutation(internal.segmentTranscription.completeChunk, {
      ...args,
      cursor: next.cursor,
      leaseUntil: next.leaseUntil,
      nextIndex: 8,
      text: 'The last sentence.',
      vtt: '00:00:28.000 --> 00:00:30.000\nThe last sentence.\n\n',
    })
    const captions = await t.query(internal.segmentMedia.captions, { recordingId, userId })
    expect(captions.captionsVtt).toContain('The last sentence.')
    expect(captions.captionsVtt?.match(/The first sentence/g)).toHaveLength(1)
    expect((await t.run((ctx) => ctx.db.get(bondfireId)))?.captionsReadyAt).toBeTypeOf('number')
    expect((await t.run((ctx) => ctx.db.get(claim.jobId)))?.insightsStatus).toBe('queued')
    expect(await t.run((ctx) => enqueueTranscription(ctx, recordingId))).toBe(false)
  })
  it('does not recreate transcripts after deletion and refuses revoked caption access', async () => {
    const { t, recordingId, bondfireId, userId } = await setup()
    const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(claim)
    await t.run((ctx) => ctx.db.delete(bondfireId))
    expect(
      await t.mutation(internal.segmentTranscription.completeChunk, {
        recordingId,
        jobId: claim.jobId,
        cursor: 0,
        leaseUntil: claim.leaseUntil,
        nextIndex: 6,
        text: 'private',
        vtt: 'private',
      }),
    ).toBe(false)
    expect(await t.run((ctx) => ctx.db.query('videoTranscripts').collect())).toHaveLength(0)
    await expect(t.query(internal.segmentMedia.captions, { recordingId, userId })).rejects.toThrow()
  })
  it('bounds retries instead of spinning forever', async () => {
    const { t, recordingId } = await setup()
    for (let i = 0; i < 5; i++) {
      const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
      assert(claim)
      await t.mutation(internal.segmentTranscription.failedChunk, {
        jobId: claim.jobId,
        leaseUntil: claim.leaseUntil,
      })
      await t.run((ctx) => ctx.db.patch(claim.jobId, { leaseUntil: 0 }))
    }
    expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
  })
})
describe('caption timing', () => {
  it('covers every segment with bounded overlap and no gaps', () => {
    const segments = Array.from({ length: 40 }, (_, index) => ({
      index,
      duration: 4,
      size: 1_000_000,
    }))
    let cursor = 0,
      end = 0
    while (cursor < segments.length) {
      const w = transcriptionWindow(segments, cursor)
      expect(w.ownedStart).toBe(end)
      expect(w.nextIndex).toBeGreaterThan(cursor)
      expect(w.duration).toBeLessThanOrEqual(30)
      cursor = w.nextIndex
      end = w.ownedEnd
    }
    expect(end).toBe(160)
  })
  it('never groups oversized fragments above the memory bound', () => {
    const segments = Array.from({ length: 4 }, (_, index) => ({
      index,
      duration: 4,
      size: 8 * 1024 * 1024,
    }))
    expect(transcriptionWindow(segments, 1)).toMatchObject({
      startIndex: 1,
      endIndex: 2,
      nextIndex: 2,
    })
  })
  it('offsets later windows, excludes context words and escapes caption markup', () => {
    const cues = speechCues(
      [
        {
          words: [
            { start: 0, end: 1, word: 'previous' },
            { start: 4, end: 5, word: '<new>' },
            { start: 8, end: 9, word: 'next' },
          ],
        },
      ],
      { startTime: 20, ownedStart: 24, ownedEnd: 28 },
    )
    expect(cues).toEqual([{ start: 24, end: 25, text: '<new>' }])
    expect(cuesToVtt(cues)).toContain('00:00:24.000 --> 00:00:25.000\n&lt;new&gt;')
  })
})

describe('R2 insights source', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('summarizes stored R2 speech without contacting Mux', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test')
    const { t, recordingId, bondfireId } = await setup()
    await t.run((ctx) =>
      ctx.db.insert('videoTranscripts', {
        bondfireId,
        segmentRecordingId: recordingId,
        text: 'We are planning a camping trip next weekend and bringing the kids.',
        createdAt: Date.now(),
      }),
    )
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Plans a camping trip with the kids next weekend.',
                tags: ['camping'],
              }),
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(
      await t.action(internal.ai.processVideoTranscript, {
        table: 'bondfires',
        recordId: bondfireId,
        segmentRecordingId: recordingId,
      }),
    ).toEqual({ processed: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((await t.run((ctx) => ctx.db.get(bondfireId)))?.summary).toContain('camping')
  })
})
