import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, type QueryCtx } from './_generated/server'
import { canStartMaintenanceRun, isExpectedMaintenancePage } from './lib/maintenanceRuns'
import { uploadResumeBody } from './lib/notificationCopy'
import { getSegmentVideoStatus } from './lib/videoLifecycle'

const JOB = 'upload-resume'
const STALLED_MS = 30 * 60_000
// Longer than an action's maximum runtime, so an abandoned page can safely restart.
const LEASE_MS = 15 * 60_000
const pageArgs = { runId: v.string(), cursor: v.optional(v.string()) }

function deliveryKey(recordingId: Id<'segmentRecordings'>) {
  return `upload-resume:${recordingId}`
}

async function delivery(ctx: QueryCtx, recording: Doc<'segmentRecordings'>) {
  return await ctx.db
    .query('notificationDeliveries')
    .withIndex('by_video_user', (q) =>
      q.eq('videoKey', deliveryKey(recording._id)).eq('userId', recording.userId),
    )
    .first()
}

async function candidate(ctx: QueryCtx, recording: Doc<'segmentRecordings'>, now: number) {
  if (
    recording.status !== 'uploading' ||
    recording.updatedAt > now - STALLED_MS ||
    getSegmentVideoStatus(recording) === 'ready' ||
    (await delivery(ctx, recording))
  )
    return null

  const owner = await ctx.db.get(recording.userId)
  if (!owner || owner.accountDeletionStatus) return null
  const response = recording.responseId ? await ctx.db.get(recording.responseId) : null
  if (recording.responseId && !response) return null
  const source = recording.bondfireId
    ? await ctx.db.get(recording.bondfireId)
    : response
      ? await ctx.db.get(response.bondfireId)
      : null
  if (
    !source ||
    (source.expiresAt !== undefined && source.expiresAt <= now) ||
    (response ?? source).segmentRecordingId !== recording._id
  )
    return null

  return {
    userId: recording.userId,
    bondfireId: source._id,
    bondfireVideoId: response?._id,
    recordingId: recording._id,
  }
}

async function expectedRun(ctx: QueryCtx, args: { runId: string; cursor?: string }) {
  const run = await ctx.db
    .query('maintenanceJobRuns')
    .withIndex('by_job', (q) => q.eq('job', JOB))
    .unique()
  if (
    !run ||
    run.runId !== args.runId ||
    run.status !== 'running' ||
    !isExpectedMaintenancePage(run.cursor, args.cursor)
  )
    return null
  return run
}

/** Cron entry point: one durable lease for the entire paginated sweep. */
export const startSweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', JOB))
      .unique()
    if (!canStartMaintenanceRun(existing, now, LEASE_MS)) return false
    const runId = `${now}-${Math.random().toString(36).slice(2)}`
    const run = {
      job: JOB,
      runId,
      status: 'running' as const,
      startedAt: now,
      updatedAt: now,
      pagesProcessed: 0,
      stats: { claimed: false },
    }
    if (existing) await ctx.db.replace(existing._id, run)
    else await ctx.db.insert('maintenanceJobRuns', run)
    await ctx.scheduler.runAfter(0, internal.uploadResumeNudges.sendPage, { runId })
    return true
  },
})

/** Claim before any external sends; duplicate or stale page actions do no work. */
export const claimPage = internalMutation({
  args: pageArgs,
  handler: async (ctx, args) => {
    const run = await expectedRun(ctx, args)
    if (!run || run.stats.claimed) return null
    const page = await ctx.db
      .query('segmentRecordings')
      .withIndex('by_status_created', (q) => q.eq('status', 'uploading'))
      .paginate({ cursor: args.cursor ?? null, numItems: 25 })
    const recordingIds: Id<'segmentRecordings'>[] = []
    for (const recording of page.page) {
      if (await candidate(ctx, recording, Date.now())) recordingIds.push(recording._id)
    }
    await ctx.db.patch(run._id, { updatedAt: Date.now(), stats: { claimed: true } })
    return { recordingIds, nextCursor: page.continueCursor, isDone: page.isDone }
  },
})

/** Receipts, cancellation, expiry, or deletion may have happened since discovery. */
export const getCandidate = internalQuery({
  args: { ...pageArgs, recordingId: v.id('segmentRecordings') },
  handler: async (ctx, args) => {
    const run = await expectedRun(ctx, args)
    if (!run || !run.stats.claimed) return null
    const recording = await ctx.db.get(args.recordingId)
    return recording ? await candidate(ctx, recording, Date.now()) : null
  },
})

export const recordDelivery = internalMutation({
  args: { recordingId: v.id('segmentRecordings'), userId: v.id('users') },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('notificationDeliveries')
      .withIndex('by_video_user', (q) =>
        q.eq('videoKey', deliveryKey(args.recordingId)).eq('userId', args.userId),
      )
      .first()
    if (existing) return
    await ctx.db.insert('notificationDeliveries', {
      userId: args.userId,
      videoKey: deliveryKey(args.recordingId),
      threadKey: JOB,
      sentAt: Date.now(),
    })
  },
})

export const finishPage = internalMutation({
  args: { ...pageArgs, nextCursor: v.string(), isDone: v.boolean() },
  handler: async (ctx, args) => {
    const run = await expectedRun(ctx, args)
    if (!run || !run.stats.claimed) return
    const now = Date.now()
    await ctx.db.patch(run._id, {
      cursor: args.isDone ? undefined : args.nextCursor,
      status: args.isDone ? 'complete' : 'running',
      updatedAt: now,
      completedAt: args.isDone ? now : undefined,
      pagesProcessed: run.pagesProcessed + 1,
      stats: { claimed: false },
    })
    if (!args.isDone)
      await ctx.scheduler.runAfter(0, internal.uploadResumeNudges.sendPage, {
        runId: args.runId,
        cursor: args.nextCursor,
      })
  },
})

export const sendPage = internalAction({
  args: pageArgs,
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.runMutation(internal.uploadResumeNudges.claimPage, args)
    if (!page) return
    for (const recordingId of page.recordingIds) {
      const recipient = await ctx.runQuery(internal.uploadResumeNudges.getCandidate, {
        ...args,
        recordingId,
      })
      if (!recipient) continue
      const result = await ctx.runAction(internal.sendNotification.sendToUser, {
        userId: recipient.userId,
        title: 'Upload paused',
        body: uploadResumeBody(),
        category: 'account',
        data: {
          type: 'upload-resume',
          bondfireId: recipient.bondfireId,
          bondfireVideoId: recipient.bondfireVideoId,
          recordingId,
        },
      })
      // No tokens is terminal too: do not poll this recording forever. All other
      // failures remain unclaimed for the next cron, never a tight-loop retry.
      if (result.success || result.error === 'No device tokens found for user')
        await ctx.runMutation(internal.uploadResumeNudges.recordDelivery, {
          recordingId,
          userId: recipient.userId,
        })
    }
    await ctx.runMutation(internal.uploadResumeNudges.finishPage, {
      ...args,
      nextCursor: page.nextCursor,
      isDone: page.isDone,
    })
  },
})
