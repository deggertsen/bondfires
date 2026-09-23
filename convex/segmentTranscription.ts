import { v } from 'convex/values'
import {
  cuesToVtt,
  type SpeechSegment,
  speechCues,
  transcriptionWindow,
} from '../packages/media/src/transcription'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { retainedVideoExists } from './retentionCleanup'
import { requireSegmentMedia } from './segmentMedia'

const LEASE_MS = 180_000
const MAX_ATTEMPTS = 5
const jobArgs = { recordingId: v.id('segmentRecordings') }
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
      await ctx.db.patch(job._id, { status: 'failed', updatedAt: Date.now() })
      return null
    }
    const segments = await ctx.db
      .query('mediaSegments')
      .withIndex('by_recording_index', (q) => q.eq('recordingId', recordingId))
      .collect()
    const window = transcriptionWindow(segments, job.cursor)
    const leaseUntil = Date.now() + LEASE_MS
    await ctx.db.patch(job._id, {
      status: 'running',
      leaseUntil,
      attempts: job.attempts + 1,
      updatedAt: Date.now(),
    })
    return { jobId: job._id, cursor: job.cursor, leaseUntil, ...window }
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
    const existing = await transcript(ctx, recording)
    const matches = existing?.segmentRecordingId === recording._id
    const text = `${matches ? existing.text : ''}${args.text ? ` ${args.text}` : ''}`.trim()
    const captionsVtt = `${matches ? (existing.captionsVtt ?? 'WEBVTT\n\n') : 'WEBVTT\n\n'}${args.vtt}`
    if (text.length > 150_000 || captionsVtt.length > 500_000)
      throw Error('Transcript exceeds bounds')
    const fields = {
      segmentRecordingId: recording._id,
      muxAssetId: undefined,
      muxTrackId: undefined,
      languageCode: args.language ?? existing?.languageCode,
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
      status: done ? 'ready' : 'queued',
      attempts: 0,
      leaseUntil: 0,
      updatedAt: Date.now(),
      ...(done ? { insightsStatus: 'queued' as const } : {}),
    })
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
export const failedChunk = internalMutation({
  args: { jobId: v.id('segmentTranscriptionJobs'), leaseUntil: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'running' || job.leaseUntil !== args.leaseUntil) return
    const exhausted = job.attempts >= MAX_ATTEMPTS
    const delay = Math.min(300_000, 15_000 * 2 ** job.attempts)
    await ctx.db.patch(job._id, {
      status: exhausted ? 'failed' : 'queued',
      leaseUntil: Date.now() + delay,
      updatedAt: Date.now(),
    })
    if (!exhausted)
      await ctx.scheduler.runAfter(delay, internal.segmentTranscription.run, {
        recordingId: job.recordingId,
      })
    await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
      level: exhausted ? 'error' : 'warn',
      event: 'media:transcription:failed',
      message: exhausted ? 'Caption generation exhausted retries' : 'Caption generation will retry',
      data: { recordingId: job.recordingId, attempt: job.attempts },
    })
  },
})
export const run = internalAction({
  args: jobArgs,
  handler: async (ctx, args) => {
    const window = await ctx.runMutation(internal.segmentTranscription.claim, args)
    if (!window) return
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
      if (!response.ok) throw Error(`Transcription HTTP ${response.status}`)
      const result = (await response.json()) as {
        text: string
        segments: SpeechSegment[]
        language?: string
        duration?: number
      }
      if (
        typeof result.text !== 'string' ||
        !Array.isArray(result.segments) ||
        result.segments.length > 2000
      )
        throw Error('Invalid transcription result')
      if (result.duration !== undefined && Math.abs(result.duration - window.duration) > 1.5)
        throw Error('Transcription timing mismatch')
      const cues = speechCues(result.segments, window)
      if (result.text.trim() && !result.segments.length) throw Error('Missing caption timestamps')
      await ctx.runMutation(internal.segmentTranscription.completeChunk, {
        recordingId: args.recordingId,
        jobId: window.jobId,
        cursor: window.cursor,
        leaseUntil: window.leaseUntil,
        nextIndex: window.nextIndex,
        text: cues.map((c) => c.text).join(' '),
        vtt: cuesToVtt(cues),
        language: result.language,
      })
    } catch {
      await ctx.runMutation(internal.segmentTranscription.failedChunk, {
        jobId: window.jobId,
        leaseUntil: window.leaseUntil,
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
  },
})
