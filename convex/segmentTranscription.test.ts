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
  vi.unstubAllGlobals()
})
async function setup(t = convexTest(schema, modules)) {
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
/** Drive a recording's caption job to the terminal `failed` state. */
async function driveToFailure(
  t: Awaited<ReturnType<typeof setup>>['t'],
  recordingId: Awaited<ReturnType<typeof setup>>['recordingId'],
) {
  for (let i = 0; i < 5; i++) {
    const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(claim)
    await t.mutation(internal.segmentTranscription.failedChunk, {
      jobId: claim.jobId,
      leaseUntil: claim.leaseUntil,
    })
    await t.run((ctx) => ctx.db.patch(claim.jobId, { leaseUntil: 0 }))
  }
  // One more claim observes attempts >= MAX_ATTEMPTS and marks the job terminal.
  expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
}
async function seedFailedBacklog(
  t: Awaited<ReturnType<typeof setup>>['t'],
  count: number,
  kind: 'already-retried' | 'dead-destination',
) {
  const jobIds = []
  for (let i = 0; i < count; i++) {
    const { recordingId, bondfireId } = await setup(t)
    jobIds.push(
      await t.run(async (ctx) => {
        const job = await ctx.db
          .query('segmentTranscriptionJobs')
          .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
          .unique()
        assert(job)
        await ctx.db.patch(job._id, {
          status: 'failed',
          attempts: 5,
          leaseUntil: 0,
          autoRetriedAt: kind === 'already-retried' ? Date.now() : undefined,
        })
        if (kind === 'dead-destination') await ctx.db.delete(bondfireId)
        return job._id
      }),
    )
  }
  return jobIds
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
  it('auto-revives a terminal failure once, then leaves it terminal', async () => {
    const { t, recordingId } = await setup()
    await driveToFailure(t, recordingId)
    const job = await t.run((ctx) =>
      ctx.db
        .query('segmentTranscriptionJobs')
        .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
        .unique(),
    )
    assert(job)
    expect(job.status).toBe('failed')
    await t.mutation(internal.segmentTranscription.recover, {})
    const revived = await t.run((ctx) => ctx.db.get(job._id))
    expect(revived?.status).toBe('queued')
    expect(revived?.attempts).toBe(0)
    expect(revived?.autoRetriedAt).toBeTypeOf('number')
    await driveToFailure(t, recordingId)
    await t.mutation(internal.segmentTranscription.recover, {})
    expect((await t.run((ctx) => ctx.db.get(job._id)))?.status).toBe('failed')
  })
  it.each(['operator', 'recover'] as const)(
    'shares a single revival budget when %s requeues first',
    async (first) => {
      const { t, recordingId } = await setup()
      await driveToFailure(t, recordingId)
      if (first === 'operator')
        expect(
          await t.mutation(internal.segmentTranscription.requeueFailed, { recordingId }),
        ).toEqual({ requeued: 1 })
      else await t.mutation(internal.segmentTranscription.recover, {})
      const job = await t.run((ctx) => ctx.db.query('segmentTranscriptionJobs').first())
      assert(job)
      expect(job).toMatchObject({ status: 'queued', attempts: 0 })
      expect(job.autoRetriedAt).toBeTypeOf('number')
      await driveToFailure(t, recordingId)
      for (let i = 0; i < 3; i++) {
        await t.mutation(internal.segmentTranscription.recover, {})
        expect(
          await t.mutation(internal.segmentTranscription.requeueFailed, { recordingId }),
        ).toEqual({ requeued: 0 })
        expect(await t.mutation(internal.segmentTranscription.requeueFailed, {})).toEqual({
          requeued: 0,
        })
        await t.mutation(internal.segmentTranscription.backfill, {})
        expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
      }
      expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({
        status: 'failed',
        attempts: 5,
        autoRetriedAt: job.autoRetriedAt,
      })
    },
  )
  it.each(['missing_audio', 'zero_duration', 'unsupported_codec'] as const)(
    'marks %s terminal on its first attempt and records compact diagnostics',
    async (reason) => {
      vi.stubEnv('MEDIA_WORKER_URL', 'https://media.example')
      vi.stubEnv('MEDIA_WORKER_SECRET', 'test')
      const failure = {
        reason,
        name: 'TranscriptionError',
        message: 'Media cannot be transcribed',
        probe: { status: reason, duration: 0, audioCodec: 'mp4a' },
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ failure }, { status: 422 })),
      )
      const { t, recordingId } = await setup()
      await t.action(internal.segmentTranscription.run, { recordingId })
      const job = await t.run((ctx) => ctx.db.query('segmentTranscriptionJobs').first())
      expect(job).toMatchObject({
        status: 'failed',
        attempts: 1,
        failureReason: reason,
        leaseUntil: Number.MAX_SAFE_INTEGER,
      })
      const logs = await t.run((ctx) => ctx.db.query('clientLogs').collect())
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        event: 'media:transcription:failed',
        level: 'error',
        data: { recordingId, attempt: 1, cursor: 0, terminal: true, ...failure },
      })
      expect(JSON.stringify(logs[0].data).length).toBeLessThan(700)
      for (let i = 0; i < 3; i++) {
        await t.mutation(internal.segmentTranscription.recover, {})
        expect(
          await t.mutation(internal.segmentTranscription.requeueFailed, { recordingId }),
        ).toEqual({ requeued: 0 })
        expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
      }
      const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      // Only the original enqueue exists; failure did not schedule any retries.
      expect(scheduled).toHaveLength(1)
    },
  )
  it('keeps transient HTTP/provider errors retryable and records their bounded reason', async () => {
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.example')
    vi.stubEnv('MEDIA_WORKER_SECRET', 'test')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private upstream body', { status: 503 })),
    )
    const { t, recordingId } = await setup()
    await t.action(internal.segmentTranscription.run, { recordingId })
    expect(await t.run((ctx) => ctx.db.query('segmentTranscriptionJobs').first())).toMatchObject({
      status: 'queued',
      attempts: 1,
    })
    expect(await t.run((ctx) => ctx.db.query('clientLogs').first())).toMatchObject({
      level: 'warn',
      data: {
        reason: 'transcription_error',
        name: 'Error',
        message: 'Transcription HTTP 503',
        probe: { status: 'not_probed' },
        terminal: false,
      },
    })
  })
  it.each(['missing_audio', 'zero_duration', 'unsupported_codec'])(
    'does not promote normalized %s text to a terminal failure without matching probe evidence',
    async (reason) => {
      const { t, recordingId } = await setup()
      const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
      assert(claim)
      await t.mutation(internal.segmentTranscription.failedChunk, {
        jobId: claim.jobId,
        leaseUntil: claim.leaseUntil,
        failure: {
          reason: ` ${reason}\n`,
          name: 'Error',
          message: 'Unconfirmed failure',
          probe: { status: 'not_probed' },
        },
      })
      expect(await t.run((ctx) => ctx.db.query('segmentTranscriptionJobs').first())).toMatchObject({
        status: 'queued',
        failureReason: 'transcription_error',
      })
      expect(await t.run((ctx) => ctx.db.query('clientLogs').first())).toMatchObject({
        data: { terminal: false, probe: { status: 'not_probed' } },
      })
    },
  )
  it('preserves HTTP diagnostics when the response stream fails', async () => {
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.example')
    vi.stubEnv('MEDIA_WORKER_SECRET', 'test')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('Private upstream stream failure'))
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    const { t, recordingId } = await setup()
    await t.action(internal.segmentTranscription.run, { recordingId })
    expect(await t.run((ctx) => ctx.db.query('clientLogs').first())).toMatchObject({
      data: { message: 'Transcription HTTP 503', terminal: false },
    })
  })
  it('counts invalid timeline failures instead of rolling back the retry budget', async () => {
    const { t, recordingId } = await setup()
    const job = await t.run(async (ctx) => {
      const segment = await ctx.db.query('mediaSegments').first()
      assert(segment)
      await ctx.db.patch(segment._id, { duration: 0 })
      return ctx.db.query('segmentTranscriptionJobs').first()
    })
    assert(job)
    for (let i = 0; i < 5; i++) {
      expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
      await t.run((ctx) => ctx.db.patch(job._id, { leaseUntil: 0 }))
    }
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({
      status: 'failed',
      attempts: 5,
    })
    const logs = await t.run((ctx) => ctx.db.query('clientLogs').collect())
    expect(logs).toHaveLength(5)
    expect(logs[0].data).toMatchObject({ message: 'Invalid timeline' })
  })
  it('marks a wholly zero-duration timeline terminal before requesting transcription', async () => {
    const { t, recordingId } = await setup()
    await t.run(async (ctx) => {
      for (const segment of await ctx.db.query('mediaSegments').collect())
        await ctx.db.patch(segment._id, { duration: 0 })
    })
    expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('segmentTranscriptionJobs').first())).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: 'zero_duration',
    })
  })
  it('ignores a stale failure from an expired lease', async () => {
    const { t, recordingId } = await setup()
    const first = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(first)
    vi.setSystemTime(Date.now() + 180001)
    const newer = await t.mutation(internal.segmentTranscription.claim, { recordingId })
    assert(newer)
    await t.mutation(internal.segmentTranscription.failedChunk, {
      jobId: first.jobId,
      leaseUntil: first.leaseUntil,
      failure: {
        reason: 'missing_audio',
        name: 'TranscriptionError',
        message: 'stale',
        probe: { status: 'missing_audio' },
      },
    })
    expect(await t.run((ctx) => ctx.db.get(newer.jobId))).toMatchObject({
      status: 'running',
      leaseUntil: newer.leaseUntil,
      attempts: 2,
    })
    expect(await t.run((ctx) => ctx.db.query('clientLogs').collect())).toHaveLength(0)
  })
  it('does not reset attempts when an interrupted action lease expires', async () => {
    const { t, recordingId } = await setup()
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = await t.mutation(internal.segmentTranscription.claim, { recordingId })
      assert(claim)
      expect((await t.run((ctx) => ctx.db.get(claim.jobId)))?.attempts).toBe(attempt)
      await t.run((ctx) => ctx.db.patch(claim.jobId, { leaseUntil: 0 }))
    }
    expect(await t.mutation(internal.segmentTranscription.claim, { recordingId })).toBeNull()
  })
  it.each(['already-retried', 'dead-destination'] as const)(
    'recovers an eligible failure behind 50 %s failures across repeated runs',
    async (kind) => {
      const { t, recordingId } = await setup()
      const skippedIds = await seedFailedBacklog(t, 50, kind)
      await driveToFailure(t, recordingId)
      const eligible = await t.run(async (ctx) => {
        const job = await ctx.db
          .query('segmentTranscriptionJobs')
          .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
          .unique()
        assert(job)
        // Sort after the skipped rows regardless of their creation order.
        await ctx.db.patch(job._id, { leaseUntil: 1 })
        return job._id
      })
      await t.mutation(internal.segmentTranscription.recover, {})
      expect((await t.run((ctx) => ctx.db.get(eligible)))?.status).toBe('failed')
      for (const id of skippedIds) {
        const skipped = await t.run((ctx) => ctx.db.get(id))
        if (kind === 'dead-destination') expect(skipped).toBeNull()
        else {
          expect(skipped?.status).toBe('failed')
          expect(skipped?.leaseUntil).toBe(Number.MAX_SAFE_INTEGER)
        }
      }
      await t.mutation(internal.segmentTranscription.recover, {})
      const revived = await t.run((ctx) => ctx.db.get(eligible))
      expect(revived?.status).toBe('queued')
      expect(revived?.attempts).toBe(0)
      expect(revived?.autoRetriedAt).toBeTypeOf('number')
    },
  )
  it.each(['already-retried', 'dead-destination'] as const)(
    'requeues an eligible failure behind 200 %s jobs across repeated calls',
    async (kind) => {
      const { t, recordingId } = await setup()
      const skippedIds = await seedFailedBacklog(t, 200, kind)
      await driveToFailure(t, recordingId)
      const eligible = await t.run(async (ctx) => {
        const job = await ctx.db
          .query('segmentTranscriptionJobs')
          .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
          .unique()
        assert(job)
        await ctx.db.patch(job._id, { leaseUntil: 1 })
        return job._id
      })
      expect(await t.mutation(internal.segmentTranscription.requeueFailed, {})).toEqual({
        requeued: 0,
      })
      expect((await t.run((ctx) => ctx.db.get(eligible)))?.status).toBe('failed')
      for (const id of skippedIds) {
        const skipped = await t.run((ctx) => ctx.db.get(id))
        if (kind === 'dead-destination') expect(skipped).toBeNull()
        else
          expect(skipped).toMatchObject({ status: 'failed', leaseUntil: Number.MAX_SAFE_INTEGER })
      }
      expect(await t.mutation(internal.segmentTranscription.requeueFailed, {})).toEqual({
        requeued: 1,
      })
      const requeued = await t.run((ctx) => ctx.db.get(eligible))
      expect(requeued?.status).toBe('queued')
      expect(requeued?.attempts).toBe(0)
      expect(await t.mutation(internal.segmentTranscription.requeueFailed, {})).toEqual({
        requeued: 0,
      })
    },
  )
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
