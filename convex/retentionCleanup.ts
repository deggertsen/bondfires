import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import { collectMuxDeletionTargets } from './lib/accountDeletionPolicy'
import { uncountResponse } from './responseCounts'
import { enqueueRetentionMedia } from './retentionMedia'

export const RETENTION_BATCH_SIZE = 25
const CLEANUP_PAGE = { cursor: null, numItems: RETENTION_BATCH_SIZE, maximumBytesRead: 1_000_000 }
const STALE_MS = 5 * 60 * 1000
type Kind = Doc<'retentionCleanupJobs'>['kind']

const VIDEO_STAGES = [
  'transcripts',
  'reports',
  'reactions',
  'presence',
  'watch',
  'deliveries',
  'digest',
  'nudge',
] as const
const ROOT_STAGES = [
  'children',
  ...VIDEO_STAGES,
  'thread_deliveries',
  'response_thread_deliveries',
  'notifications',
  'reads',
  'participants',
  'claims',
  'codes',
  'personal_codes',
  'family_codes',
  'invites',
] as const
const CAMP_STAGES = ['children', 'members', 'codes', 'claims', 'deliveries'] as const

/** Async producers must not recreate metadata after the cleanup cursor passed. */
export async function retainedVideoExists(ctx: MutationCtx | QueryCtx, recordId: string) {
  const rootId = ctx.db.normalizeId('bondfires', recordId)
  const responseId = ctx.db.normalizeId('bondfireVideos', recordId)
  const response = responseId ? await ctx.db.get(responseId) : null
  const root = rootId
    ? await ctx.db.get(rootId)
    : response
      ? await ctx.db.get(response.bondfireId)
      : null
  return !!root && (!root.campId || !!(await ctx.db.get(root.campId)))
}

async function enqueueJob(ctx: MutationCtx, kind: Kind, recordId: string) {
  const jobId = await ctx.db.insert('retentionCleanupJobs', {
    kind,
    recordId,
    stage: 0,
    revision: 0,
    updatedAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.retentionCleanup.runBatch, { jobId, revision: 0 })
}

async function inventoryVideo(ctx: MutationCtx, video: Doc<'bondfires'> | Doc<'bondfireVideos'>) {
  const session = video.liveSessionId ? await ctx.db.get(video.liveSessionId) : null
  const targets = collectMuxDeletionTargets(video, session)
  for (const id of targets.directUploads) await enqueueRetentionMedia(ctx, 'direct_upload', id)
  for (const id of targets.liveStreams) await enqueueRetentionMedia(ctx, 'live_stream', id)
  for (const id of targets.assets) await enqueueRetentionMedia(ctx, 'asset', id)
  if (session) await ctx.db.delete(session._id)
}

/**
 * Called only inside the eligibility transaction (or an already claimed Camp).
 * Removing the parent is the irreversible claim: existing access/write guards
 * now reject the ID. No external side effect occurs until its durable outbox
 * commits. A concurrent reply/upgrade either commits first and is rechecked,
 * or loses to this deletion and cannot attach a new video to the missing root.
 */
export async function claimBondfire(ctx: MutationCtx, bondfire: Doc<'bondfires'>) {
  await inventoryVideo(ctx, bondfire)
  await enqueueJob(ctx, 'bondfire', bondfire._id)
  await ctx.db.delete(bondfire._id)
  if (bondfire.status !== 'draft') {
    const user = await ctx.db.get(bondfire.userId)
    if (user)
      await ctx.db.patch(user._id, {
        bondfireCount: Math.max(0, (user.bondfireCount ?? 0) - 1),
        updatedAt: Date.now(),
      })
    const camp = bondfire.campId ? await ctx.db.get(bondfire.campId) : null
    if (camp)
      await ctx.db.patch(camp._id, {
        bondfireCount: Math.max(0, (camp.bondfireCount ?? 0) - 1),
        updatedAt: Date.now(),
      })
  }
  // Pins already resolve by ID and pinBondfire lazily prunes missing IDs.
  // Do not scan the entire users table for every expired thread.
}

async function claimResponse(ctx: MutationCtx, response: Doc<'bondfireVideos'>) {
  await inventoryVideo(ctx, response)
  await enqueueJob(ctx, 'response', response._id)
  await uncountResponse(ctx, response)
  await ctx.db.delete(response._id)
}

export async function claimCamp(ctx: MutationCtx, camp: Doc<'camps'>) {
  await enqueueJob(ctx, 'camp', camp._id)
  if (camp.coverImageStorageId) await ctx.storage.delete(camp.coverImageStorageId)
  await ctx.db.delete(camp._id)
}

async function videoRows(
  ctx: MutationCtx,
  kind: 'bondfire' | 'response',
  recordId: string,
  stage: string,
): Promise<{ page: Array<{ _id: Id<TableNames> }>; isDone: boolean }> {
  const id = ctx.db.normalizeId(kind === 'bondfire' ? 'bondfires' : 'bondfireVideos', recordId)
  if (!id) throw new Error('Invalid retained video ID')
  if (stage === 'watch')
    return await ctx.db
      .query('watchEvents')
      .withIndex('by_video', (q) => q.eq('videoId', id))
      .paginate(CLEANUP_PAGE)
  if (stage === 'presence')
    return await ctx.db
      .query('presence')
      .withIndex('by_video', (q) => q.eq('videoType', kind).eq('videoId', id))
      .paginate(CLEANUP_PAGE)
  if (stage === 'deliveries')
    return await ctx.db
      .query('notificationDeliveries')
      .withIndex('by_video_user', (q) => q.eq('videoKey', id))
      .paginate(CLEANUP_PAGE)
  if (stage === 'digest' || stage === 'nudge')
    return await ctx.db
      .query('notificationDeliveries')
      .withIndex('by_video_user', (q) => q.eq('videoKey', `${stage}:${id}`))
      .paginate(CLEANUP_PAGE)
  if (kind === 'response') {
    const responseId = id as Id<'bondfireVideos'>
    if (stage === 'transcripts')
      return await ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', responseId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'reports')
      return await ctx.db
        .query('reports')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', responseId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'reactions')
      return await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', responseId))
        .paginate(CLEANUP_PAGE)
  } else {
    const bondfireId = id as Id<'bondfires'>
    if (stage === 'transcripts')
      return await ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'reports')
      return await ctx.db
        .query('reports')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'reactions')
      return await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'thread_deliveries')
      return await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_thread', (q) => q.eq('threadKey', id))
        .paginate(CLEANUP_PAGE)
    if (stage === 'response_thread_deliveries')
      return await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_thread', (q) => q.eq('threadKey', `${id}:resp`))
        .paginate(CLEANUP_PAGE)
    if (stage === 'notifications')
      return await ctx.db
        .query('notifications')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'reads')
      return await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'participants')
      return await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'claims')
      return await ctx.db
        .query('inviteClaims')
        .withIndex('by_bondfire_claimer', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (stage === 'invites')
      return await ctx.db
        .query('bondfireInvites')
        .withIndex('by_bondfire_recipient', (q) => q.eq('bondfireId', bondfireId))
        .paginate(CLEANUP_PAGE)
    if (['codes', 'personal_codes', 'family_codes'].includes(stage)) {
      const parentType =
        stage === 'codes'
          ? 'bondfire'
          : stage === 'personal_codes'
            ? 'personal-bondfire'
            : 'family-connection'
      return await ctx.db
        .query('inviteCodes')
        .withIndex('by_parent', (q) => q.eq('parentType', parentType).eq('parentId', id))
        .paginate(CLEANUP_PAGE)
    }
  }
  throw new Error(`Unknown retention video stage ${stage}`)
}

export const runBatch = internalMutation({
  args: { jobId: v.id('retentionCleanupJobs'), revision: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.revision !== args.revision) return
    const stages =
      job.kind === 'camp' ? CAMP_STAGES : job.kind === 'bondfire' ? ROOT_STAGES : VIDEO_STAGES
    const stage = stages[job.stage]
    if (!stage) throw new Error('Invalid retention cleanup stage')
    let more = false
    let page: { page: Array<{ _id: Id<TableNames> }>; isDone: boolean } = { page: [], isDone: true }
    if (stage === 'children') {
      if (job.kind === 'camp') {
        const id = ctx.db.normalizeId('camps', job.recordId)
        if (!id) throw new Error('Invalid retained Camp ID')
        const child = await ctx.db
          .query('bondfires')
          .withIndex('by_camp', (q) => q.eq('campId', id))
          .first()
        if (child) {
          await claimBondfire(ctx, child)
          more = true
        }
      } else {
        const id = ctx.db.normalizeId('bondfires', job.recordId)
        if (!id) throw new Error('Invalid retained Bondfire ID')
        const child = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', id))
          .first()
        if (child) {
          await claimResponse(ctx, child)
          more = true
        }
      }
    } else if (job.kind === 'camp') {
      const id = ctx.db.normalizeId('camps', job.recordId)
      if (!id) throw new Error('Invalid retained Camp ID')
      if (stage === 'members')
        page = await ctx.db
          .query('campMembers')
          .withIndex('by_camp', (q) => q.eq('campId', id))
          .paginate(CLEANUP_PAGE)
      if (stage === 'codes')
        page = await ctx.db
          .query('inviteCodes')
          .withIndex('by_parent', (q) => q.eq('parentType', 'camp').eq('parentId', id))
          .paginate(CLEANUP_PAGE)
      if (stage === 'claims')
        page = await ctx.db
          .query('inviteClaims')
          .withIndex('by_camp_claimer', (q) => q.eq('campId', id))
          .paginate(CLEANUP_PAGE)
      if (stage === 'deliveries')
        page = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_thread', (q) => q.eq('threadKey', `campstage:${id}`))
          .paginate(CLEANUP_PAGE)
      // campSlotTransactions is an immutable billing ledger; retain it.
    } else {
      page = await videoRows(ctx, job.kind, job.recordId, stage)
    }
    for (const row of page.page) await ctx.db.delete(row._id)
    const nextStage = more || !page.isDone ? job.stage : job.stage + 1
    if (nextStage === stages.length) {
      await ctx.db.delete(job._id)
    } else {
      const revision = job.revision + 1
      await ctx.db.patch(job._id, { stage: nextStage, revision, updatedAt: Date.now() })
      await ctx.scheduler.runAfter(0, internal.retentionCleanup.runBatch, {
        jobId: job._id,
        revision,
      })
    }
  },
})

/** Catch interrupted database jobs, scans, and external-media attempts. */
export const resumeStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db
      .query('retentionCleanupJobs')
      .withIndex('by_updated', (q) => q.lte('updatedAt', Date.now() - STALE_MS))
      .take(RETENTION_BATCH_SIZE)
    for (const job of jobs) {
      await ctx.db.patch(job._id, { updatedAt: Date.now() })
      await ctx.scheduler.runAfter(0, internal.retentionCleanup.runBatch, {
        jobId: job._id,
        revision: job.revision,
      })
    }
    for (const kind of ['bondfire', 'camp'] as const) {
      const run = await ctx.db
        .query('maintenanceJobRuns')
        .withIndex('by_job', (q) => q.eq('job', `retention-${kind}`))
        .first()
      if (run?.status === 'running' && run.updatedAt <= Date.now() - STALE_MS) {
        await ctx.scheduler.runAfter(0, internal.bondfireRetention.scanPage, {
          kind,
          runId: run.runId,
          cursor: run.cursor,
        })
      }
    }
    await ctx.scheduler.runAfter(0, internal.retentionMedia.drain, {})
  },
})
