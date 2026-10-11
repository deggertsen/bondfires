import { v } from 'convex/values'
import {
  cuesToVtt,
  isTerminalTranscriptionFailure,
  type MediaProbe,
  normalizeTranscriptionFailure,
  readMediaProbe,
  readTranscriptionFailure,
  readTranscriptionFailureResponse,
  type SpeechSegment,
  speechCues,
  TRANSCRIPTION_WINDOW_SEGMENTS,
  TranscriptionError,
  type TranscriptionFailure,
  transcriptionWindow,
} from '../packages/media/src/transcription'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { retainedVideoExists } from './retentionCleanup'
import { requireSegmentMedia } from './segmentMedia'
import { logServerEvent } from './serverTelemetry'

const LEASE_MS = 180_000
const MAX_ATTEMPTS = 5
const TIMING_BACKFILL_SEGMENTS = 256
const jobArgs = { recordingId: v.id('segmentRecordings') }

// speechCues intentionally filters silence and context. Validate the provider's
// timestamp structure first so malformed speech cannot become a permanent gap.
function validSpeechSegments(value: unknown): value is SpeechSegment[] {
  if (!Array.isArray(value) || value.length > 2000) return false
  const timedText = (item: unknown, textKey: 'text' | 'word') => {
    if (!item || typeof item !== 'object') return false
    const cue = item as Record<string, unknown>
    return (
      typeof cue[textKey] === 'string' &&
      typeof cue.start === 'number' &&
      Number.isFinite(cue.start) &&
      cue.start >= 0 &&
      typeof cue.end === 'number' &&
      Number.isFinite(cue.end) &&
      cue.end >= cue.start
    )
  }
  return value.every((segment) => {
    if (!segment || typeof segment !== 'object') return false
    if (
      segment.no_speech_prob !== undefined &&
      (typeof segment.no_speech_prob !== 'number' ||
        !Number.isFinite(segment.no_speech_prob) ||
        segment.no_speech_prob < 0 ||
        segment.no_speech_prob > 1)
    )
      return false
    if (segment.words !== undefined && !Array.isArray(segment.words)) return false
    return segment.words?.length
      ? segment.words.every((word: unknown) => timedText(word, 'word'))
      : timedText(segment, 'text')
  })
}

async function destination(ctx: QueryCtx | MutationCtx, recordingId: Id<'segmentRecordings'>) {
  const recording = await ctx.db.get(recordingId)
  const id = recording?.responseId ?? recording?.bondfireId
  const record = id ? await ctx.db.get(id) : null
  const owner = recording ? await ctx.db.get(recording.userId) : null
  const root = record && 'bondfireId' in record ? await ctx.db.get(record.bondfireId) : record
  if (
    !recording ||
    recording.status !== 'ready' ||
    !record ||
    record.segmentRecordingId !== recordingId ||
    !owner ||
    owner.accountDeletionStatus ||
    !root ||
    root.moderationStatus === 'removed' ||
    record.moderationStatus === 'removed' ||
    (root.expiresAt !== undefined && root.expiresAt <= Date.now()) ||
    !(await retainedVideoExists(ctx, record._id))
  )
    return null
  return {
    recording,
    record,
    table: recording.responseId ? ('bondfireVideos' as const) : ('bondfires' as const),
  }
}
async function transcript(
  ctx: QueryCtx | MutationCtx,
  recording: { responseId?: Id<'bondfireVideos'>; bondfireId?: Id<'bondfires'> },
) {
  return recording.responseId
    ? ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', recording.responseId))
        .first()
    : ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', recording.bondfireId))
        .first()
}
export async function enqueueTranscription(ctx: MutationCtx, recordingId: Id<'segmentRecordings'>) {
  if (!(await destination(ctx, recordingId))) return false
  const existing = await ctx.db
    .query('segmentTranscriptionJobs')
    .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
    .unique()
  if (existing) return false
  await ctx.db.insert('segmentTranscriptionJobs', {
    recordingId,
    status: 'queued',
    cursor: 0,
    timing: { index: 0, time: 0 },
    attempts: 0,
    leaseUntil: 0,
    updatedAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.segmentTranscription.run, { recordingId })
  return true
}
export const claim = internalMutation({
  args: jobArgs,
  handler: async (ctx, { recordingId }) => {
    requireSegmentMedia()
    const job = await ctx.db
      .query('segmentTranscriptionJobs')
      .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
      .unique()
    if (!job || ['ready', 'failed'].includes(job.status) || job.leaseUntil > Date.now()) return null
    const source = await destination(ctx, recordingId)
    if (!source) {
      await ctx.db.delete(job._id)
      return null
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      await recordChunkFailure(
        ctx,
        job,
        normalizeTranscriptionFailure(
          new TranscriptionError(
            'lease_expired',
            'Transcription action exhausted its lease attempts',
          ),
        ),
      )
      return null
    }
    const leaseUntil = Date.now() + LEASE_MS
    try {
      let timing = job.timing ?? { index: 0, time: 0 }
      if (timing.index > job.cursor) throw Error('Invalid transcript timing')
      if (timing.index < job.cursor) {
        // Legacy jobs have no accumulated timestamp. Rebuild it once in bounded
        // mutations without replaying speech or appending duplicate transcript text.
        const prefix = await ctx.db
          .query('mediaSegments')
          .withIndex('by_recording_index', (q) =>
            q.eq('recordingId', recordingId).gte('index', timing.index).lt('index', job.cursor),
          )
          .take(TIMING_BACKFILL_SEGMENTS)
        if (
          !prefix.length ||
          prefix.some(
            (s, i) =>
              s.index !== timing.index + i || !Number.isFinite(s.duration) || s.duration <= 0,
          )
        )
          throw Error('Invalid timeline')
        timing = {
          index: timing.index + prefix.length,
          time: timing.time + prefix.reduce((sum, s) => sum + s.duration, 0),
        }
        // Checkpoint even the final batch separately from window construction:
        // a failed window must not discard timing or rescan the prefix on retry.
        await ctx.db.patch(job._id, {
          timing,
          status: 'queued',
          leaseUntil: 0,
          updatedAt: Date.now(),
        })
        await ctx.scheduler.runAfter(0, internal.segmentTranscription.run, { recordingId })
        return null
      }
      const segments = await ctx.db
        .query('mediaSegments')
        .withIndex('by_recording_index', (q) =>
          q
            .eq('recordingId', recordingId)
            .gte('index', Math.max(0, job.cursor - 1))
            .lt(
              'index',
              Math.min(source.recording.segmentCount, job.cursor + TRANSCRIPTION_WINDOW_SEGMENTS),
            ),
        )
        .take(TRANSCRIPTION_WINDOW_SEGMENTS + 1)
      // A ready recording's aggregate duration also confirms a zero-duration
      // timeline without reading every fragment. A partial range alone does not.
      if (
        job.cursor === 0 &&
        (segments.length === source.recording.segmentCount || source.recording.duration === 0) &&
        segments.length > 0 &&
        segments.every((segment) => segment.duration === 0)
      )
        throw new TranscriptionError('zero_duration', 'Media timeline has zero duration', {
          status: 'zero_duration',
          duration: 0,
        })
      const window = transcriptionWindow(segments, job.cursor, {
        cursorTime: timing.time,
        segmentCount: source.recording.segmentCount,
      })
      await ctx.db.patch(job._id, {
        status: 'running',
        leaseUntil,
        attempts: job.attempts + 1,
        updatedAt: Date.now(),
        timing,
        pendingTiming: { index: window.nextIndex, time: window.ownedEnd },
      })
      return { jobId: job._id, cursor: job.cursor, leaseUntil, ...window }
    } catch (error) {
      // Persist attempts even if window construction fails before the action starts.
      await recordChunkFailure(
        ctx,
        { ...job, attempts: job.attempts + 1 },
        normalizeTranscriptionFailure(error),
      )
      return null
    }
  },
})
export const completeChunk = internalMutation({
  args: {
    ...jobArgs,
    jobId: v.id('segmentTranscriptionJobs'),
    cursor: v.number(),
    leaseUntil: v.number(),
    nextIndex: v.number(),
    text: v.string(),
    vtt: v.string(),
    language: v.optional(v.string()),
    timingMismatch: v.optional(
      v.object({
        start: v.number(),
        end: v.number(),
        providerDuration: v.number(),
        expectedDuration: v.number(),
        storedDuration: v.number(),
        durationSource: v.union(v.literal('audio_probe'), v.literal('stored_window')),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (
      !job ||
      job.recordingId !== args.recordingId ||
      job.status !== 'running' ||
      job.cursor !== args.cursor ||
      job.leaseUntil !== args.leaseUntil
    )
      return false
    const source = await destination(ctx, args.recordingId)
    if (!source) {
      await ctx.db.delete(job._id)
      return false
    }
    const { recording, record } = source
    if (
      !Number.isInteger(args.nextIndex) ||
      args.nextIndex <= args.cursor ||
      args.nextIndex > recording.segmentCount
    )
      throw Error('Invalid transcript progress')
    if (job.pendingTiming && args.nextIndex !== job.pendingTiming.index)
      throw Error('Invalid transcript window progress')
    const existing = await transcript(ctx, recording)
    const matches = existing?.segmentRecordingId === recording._id
    // A NOTE records the owned gap without displaying untrusted captions or
    // inventing speech. Keep the stored media timeline for subsequent windows.
    const chunkText = args.timingMismatch ? '' : args.text
    const chunkVtt = args.timingMismatch
      ? `NOTE caption gap: timing_mismatch; start=${args.timingMismatch.start}s; end=${args.timingMismatch.end}s\n\n`
      : args.vtt
    const text = `${matches ? existing.text : ''}${chunkText ? ` ${chunkText}` : ''}`.trim()
    const captionsVtt = `${matches ? (existing.captionsVtt ?? 'WEBVTT\n\n') : 'WEBVTT\n\n'}${chunkVtt}`
    if (text.length > 150_000 || captionsVtt.length > 500_000)
      throw Error('Transcript exceeds bounds')
    const fields = {
      segmentRecordingId: recording._id,
      muxAssetId: undefined,
      muxTrackId: undefined,
      languageCode: (args.timingMismatch ? undefined : args.language) ?? existing?.languageCode,
      text,
      captionsVtt,
    }
    if (existing) await ctx.db.patch(existing._id, fields)
    else
      await ctx.db.insert('videoTranscripts', {
        ...fields,
        bondfireId: recording.bondfireId,
        bondfireVideoId: recording.responseId,
        createdAt: Date.now(),
      })
    const done = args.nextIndex === recording.segmentCount
    await ctx.db.patch(job._id, {
      cursor: args.nextIndex,
      // Old in-flight actions have no pending timing; the next claim rebuilds it.
      timing: job.pendingTiming,
      pendingTiming: undefined,
      status: done ? 'ready' : 'queued',
      attempts: 0,
      leaseUntil: 0,
      failureReason: undefined,
      updatedAt: Date.now(),
      ...(done ? { insightsStatus: 'queued' as const } : {}),
    })
    if (args.timingMismatch) {
      const { providerDuration, expectedDuration, storedDuration, durationSource } =
        args.timingMismatch
      await logServerEvent(ctx, {
        level: 'warn',
        event: 'media:transcription:skipped',
        message: normalizeTranscriptionFailure(
          Error(
            `Transcription timing mismatch: provider=${providerDuration}s expected=${expectedDuration}s source=${durationSource} stored=${storedDuration}s`,
          ),
        ).message,
        data: {
          recordingId: args.recordingId,
          cursor: args.cursor,
          nextIndex: args.nextIndex,
          attempt: job.attempts,
          reason: 'timing_mismatch',
          ...args.timingMismatch,
        },
      })
    }
    if (done) {
      await ctx.db.patch(record._id, { captionsReadyAt: Date.now() })
      await ctx.scheduler.runAfter(0, internal.segmentTranscription.summarize, {
        recordingId: recording._id,
      })
    } else
      await ctx.scheduler.runAfter(0, internal.segmentTranscription.run, {
        recordingId: recording._id,
      })
    return true
  },
})
async function recordChunkFailure(
  ctx: MutationCtx,
  job: Doc<'segmentTranscriptionJobs'>,
  failure: TranscriptionFailure,
) {
  const terminal = isTerminalTranscriptionFailure(failure.reason)
  const exhausted = job.attempts >= MAX_ATTEMPTS
  const stopped = terminal || exhausted
  const delay = Math.min(300_000, 15_000 * 2 ** job.attempts)
  await ctx.db.patch(job._id, {
    status: stopped ? 'failed' : 'queued',
    attempts: job.attempts,
    leaseUntil: terminal ? Number.MAX_SAFE_INTEGER : Date.now() + delay,
    failureReason: failure.reason,
    updatedAt: Date.now(),
  })
  if (!stopped)
    await ctx.scheduler.runAfter(delay, internal.segmentTranscription.run, {
      recordingId: job.recordingId,
    })
  await logServerEvent(ctx, {
    level: stopped ? 'error' : 'warn',
    event: 'media:transcription:failed',
    message: terminal
      ? 'Media cannot be transcribed'
      : exhausted
        ? 'Caption generation exhausted retries'
        : 'Caption generation will retry',
    data: {
      recordingId: job.recordingId,
      cursor: job.cursor,
      attempt: job.attempts,
      terminal,
      exhausted,
      ...failure,
    },
  })
}
export const failedChunk = internalMutation({
  args: {
    jobId: v.id('segmentTranscriptionJobs'),
    leaseUntil: v.number(),
    // Optional for already-scheduled actions from the previous deployment.
    failure: v.optional(
      v.object({
        reason: v.string(),
        name: v.string(),
        message: v.string(),
        probe: v.object({
          status: v.string(),
          audioCodec: v.optional(v.string()),
          duration: v.optional(v.number()),
        }),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'running' || job.leaseUntil !== args.leaseUntil) return
    const failure =
      readTranscriptionFailure({ failure: args.failure }) ??
      normalizeTranscriptionFailure(undefined)
    await recordChunkFailure(ctx, job, failure)
  },
})
export const run = internalAction({
  args: jobArgs,
  handler: async (ctx, args) => {
    const window = await ctx.runMutation(internal.segmentTranscription.claim, args)
    if (!window) return
    let failure: TranscriptionFailure | undefined
    let probe: MediaProbe = { status: 'not_probed' }
    try {
      const base = process.env.MEDIA_WORKER_URL,
        secret = process.env.MEDIA_WORKER_SECRET
      if (!base || !secret) throw Error('Media not configured')
      const response = await fetch(`${base}/internal/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordingId: args.recordingId,
          startIndex: window.startIndex,
          endIndex: window.endIndex,
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        failure = await readTranscriptionFailureResponse(response)
        throw Error(`Transcription HTTP ${response.status}`)
      }
      const result = (await response.json()) as {
        text: string
        segments: SpeechSegment[]
        language?: string
        duration?: number
        probe?: MediaProbe
      }
      probe = readMediaProbe(result.probe) ?? probe
      if (
        typeof result.text !== 'string' ||
        !validSpeechSegments(result.segments) ||
        (result.duration !== undefined &&
          (typeof result.duration !== 'number' ||
            !Number.isFinite(result.duration) ||
            result.duration < 0 ||
            result.duration > Number.MAX_SAFE_INTEGER / 1000)) ||
        (result.language !== undefined && typeof result.language !== 'string')
      )
        throw Error('Invalid transcription result')
      const cues = speechCues(result.segments, window)
      if (result.text.trim() && !result.segments.length) throw Error('Missing caption timestamps')
      // Stored durations include video stalls; Whisper only measures audio.
      const audioDuration = probe.status === 'ok' ? probe.duration : undefined
      const expectedDuration = audioDuration ?? window.duration
      const durationSource =
        audioDuration !== undefined ? ('audio_probe' as const) : ('stored_window' as const)
      const timingMismatch =
        result.duration !== undefined && Math.abs(result.duration - expectedDuration) > 1.5
          ? {
              start: window.ownedStart,
              end: window.ownedEnd,
              providerDuration: result.duration,
              expectedDuration,
              storedDuration: window.duration,
              durationSource,
            }
          : undefined
      await ctx.runMutation(internal.segmentTranscription.completeChunk, {
        recordingId: args.recordingId,
        jobId: window.jobId,
        cursor: window.cursor,
        leaseUntil: window.leaseUntil,
        nextIndex: window.nextIndex,
        text: cues.map((c) => c.text).join(' '),
        vtt: cuesToVtt(cues),
        language: result.language,
        timingMismatch,
      })
    } catch (error) {
      await ctx.runMutation(internal.segmentTranscription.failedChunk, {
        jobId: window.jobId,
        leaseUntil: window.leaseUntil,
        failure: failure ?? normalizeTranscriptionFailure(error, probe),
      })
    }
  },
})
export const claimInsights = internalMutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query('segmentTranscriptionJobs')
      .withIndex('by_recording', (q) => q.eq('recordingId', args.recordingId))
      .unique()
    if (
      !job ||
      job.status !== 'ready' ||
      job.insightsStatus !== 'queued' ||
      job.leaseUntil > Date.now()
    )
      return null
    const source = await destination(ctx, args.recordingId)
    if (!source) {
      await ctx.db.delete(job._id)
      return null
    }
    const attempts = (job.insightsAttempts ?? 0) + 1
    if (attempts > MAX_ATTEMPTS) {
      await ctx.db.patch(job._id, { insightsStatus: 'failed', leaseUntil: Number.MAX_SAFE_INTEGER })
      return null
    }
    const leaseUntil = Date.now() + LEASE_MS
    await ctx.db.patch(job._id, { insightsAttempts: attempts, leaseUntil, updatedAt: Date.now() })
    return {
      table: source.table,
      recordId: source.record._id,
      segmentRecordingId: args.recordingId,
      jobId: job._id,
      leaseUntil,
    }
  },
})
export const insightResult = internalMutation({
  args: { jobId: v.id('segmentTranscriptionJobs'), leaseUntil: v.number(), success: v.boolean() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.leaseUntil !== args.leaseUntil || job.insightsStatus !== 'queued') return
    const exhausted = (job.insightsAttempts ?? 0) >= MAX_ATTEMPTS
    const delay = 30_000 * (job.insightsAttempts ?? 1)
    await ctx.db.patch(job._id, {
      insightsStatus: args.success ? 'ready' : exhausted ? 'failed' : 'queued',
      leaseUntil: args.success || exhausted ? Number.MAX_SAFE_INTEGER : Date.now() + delay,
      updatedAt: Date.now(),
    })
    if (!args.success && !exhausted)
      await ctx.scheduler.runAfter(delay, internal.segmentTranscription.summarize, {
        recordingId: job.recordingId,
      })
    if (!args.success && exhausted)
      await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
        level: 'error',
        event: 'media:insights:failed',
        message: 'R2 summary generation exhausted retries',
        data: { recordingId: job.recordingId },
      })
  },
})
export const summarize = internalAction({
  args: jobArgs,
  handler: async (ctx, args) => {
    const source = await ctx.runMutation(internal.segmentTranscription.claimInsights, args)
    if (!source) return
    let success = false
    try {
      const result = await ctx.runAction(internal.ai.processVideoTranscript, {
        table: source.table,
        recordId: source.recordId,
        segmentRecordingId: source.segmentRecordingId,
      })
      success =
        result.processed ||
        ['already_summarized', 'transcript_too_short', 'record_not_found'].includes(
          result.reason ?? '',
        )
    } catch {
      /* The persisted lease and attempts make retries safe across action restarts. */
    }
    await ctx.runMutation(internal.segmentTranscription.insightResult, {
      jobId: source.jobId,
      leaseUntil: source.leaseUntil,
      success,
    })
  },
})
/** Paginated backfill also handles recordings that completed before deployment. */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('segmentRecordings')
      .paginate({ cursor: args.cursor ?? null, numItems: 50 })
    let queued = 0
    for (const recording of page.page) if (await enqueueTranscription(ctx, recording._id)) queued++
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.segmentTranscription.backfill, {
        cursor: page.continueCursor,
      })
    return { queued, done: page.isDone }
  },
})
/** Revive a terminal failure once when the recording still has a destination. */
async function reviveFailedJob(
  ctx: MutationCtx,
  job: Doc<'segmentTranscriptionJobs'>,
): Promise<boolean> {
  if (!(await destination(ctx, job.recordingId))) {
    await ctx.db.delete(job._id)
    return false
  }
  if (job.autoRetriedAt !== undefined || isTerminalTranscriptionFailure(job.failureReason ?? '')) {
    // Keep terminal jobs available to operators without blocking the next batch.
    await ctx.db.patch(job._id, { leaseUntil: Number.MAX_SAFE_INTEGER })
    return false
  }
  await ctx.db.patch(job._id, {
    status: 'queued',
    attempts: 0,
    leaseUntil: 0,
    autoRetriedAt: Date.now(),
    updatedAt: Date.now(),
  })
  return true
}
/**
 * Operator tool: clear terminal failures so the pipeline picks those recordings
 * back up. Pass `recordingId` for one video, or omit it to process up to 200
 * failures per call. Shares the ONE lifetime revival allowance with recovery;
 * operator calls cannot replenish the budget for unchanged, immutable media.
 * Confirmed un-transcribable media is never revived. Dead destinations are
 * deleted and spent jobs are parked so repeated calls advance the backlog.
 */
export const requeueFailed = internalMutation({
  args: { recordingId: v.optional(v.id('segmentRecordings')) },
  handler: async (ctx, args) => {
    const recordingId = args.recordingId
    const jobs = recordingId
      ? (
          await ctx.db
            .query('segmentTranscriptionJobs')
            .withIndex('by_recording', (q) => q.eq('recordingId', recordingId))
            .collect()
        ).filter((job) => job.status === 'failed')
      : await ctx.db
          .query('segmentTranscriptionJobs')
          .withIndex('by_status_lease', (q) =>
            q.eq('status', 'failed').lt('leaseUntil', Number.MAX_SAFE_INTEGER),
          )
          .take(200)
    let requeued = 0
    for (const job of jobs) {
      if (!(await reviveFailedJob(ctx, job))) continue
      await ctx.scheduler.runAfter(0, internal.segmentTranscription.run, {
        recordingId: job.recordingId,
      })
      requeued++
    }
    return { requeued }
  },
})
/** Recover interrupted actions after the lease, without duplicate transcript appends. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const status of ['queued', 'running', 'ready'] as const) {
      const jobs = await ctx.db
        .query('segmentTranscriptionJobs')
        .withIndex('by_status_lease', (q) => q.eq('status', status).lte('leaseUntil', Date.now()))
        .take(50)
      for (const job of jobs)
        await ctx.scheduler.runAfter(
          0,
          status === 'ready'
            ? internal.segmentTranscription.summarize
            : internal.segmentTranscription.run,
          {
            recordingId: job.recordingId,
          },
        )
    }
    // A terminal `failed` job was previously unrecoverable even after the cause
    // was fixed (for example an oversized transcription window). Revive each
    // stale failure exactly once so already-stuck captions heal without a manual
    // DB edit; any second failure stays terminal, including for operator requeues.
    const failures = await ctx.db
      .query('segmentTranscriptionJobs')
      .withIndex('by_status_lease', (q) => q.eq('status', 'failed').lte('leaseUntil', Date.now()))
      .take(50)
    for (const job of failures)
      if (await reviveFailedJob(ctx, job))
        await ctx.scheduler.runAfter(0, internal.segmentTranscription.run, {
          recordingId: job.recordingId,
        })
  },
})
