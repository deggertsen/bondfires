import { v } from 'convex/values'
import { mediaBackendEnabled } from '../packages/media/src/environment'
import {
  MAX_RECORDING_SECONDS,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENTS,
  MEDIA_AUDIENCE,
  signCapability,
} from '../packages/media/src/protocol'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, getTierMaxVideoDurationMs } from './entitlements'
import { getSegmentVideoStatus, isPlayableVideoRecord } from './lib/videoLifecycle'
import { countResponse, uncountResponse } from './responseCounts'
import { enqueueTranscription } from './segmentTranscription'
import { assertCanViewBondfire, assertCanViewResponse, createPendingVideoRecord } from './videos'

function isMediaEnabled() {
  return mediaBackendEnabled(
    process.env.CONVEX_CLOUD_URL,
    process.env.SEGMENT_MEDIA_ENABLED,
    process.env.INTERNAL_SEGMENT_MEDIA,
  )
}
export function requireSegmentMedia() {
  if (!isMediaEnabled()) throw new Error('Segment media is disabled')
}
async function requireUser(ctx: QueryCtx | MutationCtx) {
  requireSegmentMedia()
  const userId = await auth.getUserId(ctx)
  const user = userId && (await ctx.db.get(userId))
  if (!user || user.accountDeletionStatus) throw new Error('Sign in required')
  return user._id
}
async function linkedAccess(
  ctx: QueryCtx,
  recording: Doc<'segmentRecordings'>,
  userId: Id<'users'>,
) {
  const user = await ctx.db.get(userId)
  const owner = await ctx.db.get(recording.userId)
  if (
    !user ||
    user.accountDeletionStatus ||
    !owner ||
    owner.accountDeletionStatus ||
    recording.status === 'cancelled'
  )
    throw new Error('Forbidden')
  if (recording.responseId) {
    const response = await ctx.db.get(recording.responseId)
    const bondfire = response && (await ctx.db.get(response.bondfireId))
    if (!response || !bondfire || response.segmentRecordingId !== recording._id)
      throw new Error('Forbidden')
    await assertCanViewResponse(ctx, { userId, bondfire, response })
  } else {
    const bondfire = recording.bondfireId && (await ctx.db.get(recording.bondfireId))
    if (!bondfire || bondfire.segmentRecordingId !== recording._id) throw new Error('Forbidden')
    await assertCanViewBondfire(ctx, { userId, bondfire })
  }
}
export const begin = mutation({
  args: {
    localId: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    // Released internal clients persist null when recording without a draft.
    // Accept it so their durable upload journals can recover after an update.
    draftBondfireId: v.optional(v.union(v.id('bondfires'), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx)
    if (!/^[a-f0-9-]{36}$/.test(args.localId)) throw new Error('Invalid recording identifier')
    const existing = await ctx.db
      .query('segmentRecordings')
      .withIndex('by_owner_local', (q) => q.eq('userId', userId).eq('localId', args.localId))
      .unique()
    if (existing) {
      await linkedAccess(ctx, existing, userId)
      const recordId = existing.responseId ?? existing.bondfireId
      if (!recordId) throw new Error('Missing recording destination')
      return {
        recordingId: existing._id,
        recordId,
        maxDuration: existing.maxDuration,
      }
    }
    const parent = args.bondfireId ? await ctx.db.get(args.bondfireId) : null
    const campId = args.campId ?? parent?.campId
    const camp = campId ? await ctx.db.get(campId) : null
    const maxDuration = Math.min(
      (camp?.rules.participation.maxDurationMs ?? MAX_RECORDING_SECONDS * 1000) / 1000,
      MAX_RECORDING_SECONDS,
      (getTierMaxVideoDurationMs(await getEntitlementSubscriptionTier(ctx, userId)) ??
        MAX_RECORDING_SECONDS * 1000) / 1000,
    )
    const now = Date.now()
    const recordingId = await ctx.db.insert('segmentRecordings', {
      userId,
      localId: args.localId,
      status: 'uploading',
      segmentCount: 0,
      duration: 0,
      maxDuration,
      createdAt: now,
      updatedAt: now,
    })
    const result = await createPendingVideoRecord(ctx, {
      ...args,
      draftBondfireId: args.draftBondfireId ?? undefined,
      userId,
      segmentRecordingId: recordingId,
      playbackPolicy: 'signed',
      width: 720,
      height: 1280,
    })
    await ctx.db.patch(
      recordingId,
      result.recordType === 'response'
        ? { responseId: result.recordId as Id<'bondfireVideos'> }
        : { bondfireId: result.recordId as Id<'bondfires'> },
    )
    return { recordingId, recordId: result.recordId, maxDuration }
  },
})
/** Observe an upload's destination without putting a network request before capture. */
export const getOwnRecording = query({
  args: { localId: v.string() },
  handler: async (ctx, { localId }) => {
    requireSegmentMedia()
    const userId = await auth.getUserId(ctx)
    const user = userId && (await ctx.db.get(userId))
    if (!user || user.accountDeletionStatus) return null
    const recording = await ctx.db
      .query('segmentRecordings')
      .withIndex('by_owner_local', (q) => q.eq('userId', user._id).eq('localId', localId))
      .unique()
    if (!recording || recording.status === 'cancelled') return null
    const response = recording.responseId ? await ctx.db.get(recording.responseId) : null
    const bondfireId = response?.bondfireId ?? recording.bondfireId
    const bondfire = bondfireId ? await ctx.db.get(bondfireId) : null
    const linked = recording.responseId ? response : bondfire
    if (!bondfire || !linked || linked.segmentRecordingId !== recording._id) return null
    return {
      bondfireId: bondfire._id,
      responseId: response?._id,
      videoStatus: linked.videoStatus,
    }
  },
})
export const authorize = internalQuery({
  args: {
    recordingId: v.id('segmentRecordings'),
    userId: v.id('users'),
    operation: v.union(v.literal('upload'), v.literal('read')),
  },
  handler: async (ctx, args) => {
    requireSegmentMedia()
    const recording = await ctx.db.get(args.recordingId)
    if (!recording) throw new Error('Forbidden')
    await linkedAccess(ctx, recording, args.userId)
    if (
      args.operation === 'upload' &&
      (recording.userId !== args.userId || recording.createdAt < Date.now() - 7 * 86400_000)
    )
      throw new Error('Forbidden')
    return recording
  },
})
export const capability = action({
  args: {
    recordingId: v.id('segmentRecordings'),
    operation: v.union(v.literal('upload'), v.literal('read')),
  },
  handler: async (ctx, args): Promise<{ token: string; baseUrl: string; expiresAt: number }> => {
    requireSegmentMedia()
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Sign in required')
    await ctx.runQuery(internal.segmentMedia.authorize, { ...args, userId })
    const baseUrl = process.env.MEDIA_WORKER_URL
    const secret = process.env.MEDIA_TOKEN_SECRET
    if (!baseUrl || !secret) throw new Error('Media is not configured')
    const expiresAt = Date.now() + (args.operation === 'upload' ? 30 : 720) * 60_000
    const token = await signCapability(
      { audience: MEDIA_AUDIENCE, ...args, userId, expiresAt },
      secret,
    )
    return { token, baseUrl: `${baseUrl}/v1/${args.recordingId}`, expiresAt }
  },
})
async function updatePlayable(ctx: MutationCtx, recording: Doc<'segmentRecordings'>) {
  const videoStatus = getSegmentVideoStatus(recording)
  if (videoStatus !== 'ready' && videoStatus !== 'live') return
  const complete = videoStatus === 'ready'
  if (recording.responseId) {
    const video = await ctx.db.get(recording.responseId)
    if (!video) throw new Error('Forbidden')
    await ctx.db.patch(video._id, {
      videoStatus,
      durationMs: Math.round(recording.duration * 1000),
    })
    await countResponse(ctx, video)
    if (!isPlayableVideoRecord(video)) {
      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
        bondfireId: video.bondfireId,
        bondfireVideoId: video._id,
        responderId: video.userId,
        responderName: video.creatorName ?? 'Someone',
      })
    }
  } else if (recording.bondfireId) {
    const bondfire = await ctx.db.get(recording.bondfireId)
    if (!bondfire) throw new Error('Forbidden')
    await ctx.db.patch(recording.bondfireId, {
      videoStatus,
      durationMs: Math.round(recording.duration * 1000),
      updatedAt: Date.now(),
    })
    if (!isPlayableVideoRecord(bondfire)) {
      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
        bondfireId: bondfire._id,
        creatorId: bondfire.userId,
        creatorName: bondfire.creatorName ?? 'Someone',
      })
    }
  }
  if (complete) {
    await ctx.db.patch(recording._id, { status: 'ready' })
    await enqueueTranscription(ctx, recording._id)
  }
}
export const receipt = internalMutation({
  args: {
    recordingId: v.id('segmentRecordings'),
    userId: v.id('users'),
    index: v.number(),
    duration: v.number(),
    size: v.number(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    requireSegmentMedia()
    const recording = await ctx.db.get(args.recordingId)
    if (!recording || recording.userId !== args.userId) throw new Error('Forbidden')
    await linkedAccess(ctx, recording, args.userId)
    const { index, duration, size, checksum } = args
    if (
      !Number.isInteger(index) ||
      index < -1 ||
      index >= MAX_SEGMENTS ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > MAX_SEGMENT_BYTES ||
      !/^[a-f0-9]{64}$/.test(checksum)
    )
      throw new Error('Invalid segment')
    if (index === -1) {
      if (recording.initChecksum && recording.initChecksum !== checksum)
        throw new Error('Conflicting initialization')
      await ctx.db.patch(recording._id, { initChecksum: checksum, updatedAt: Date.now() })
      return
    }
    const old = await ctx.db
      .query('mediaSegments')
      .withIndex('by_recording_index', (q) => q.eq('recordingId', recording._id).eq('index', index))
      .unique()
    if (old) {
      if (old.checksum !== checksum || old.size !== size || old.duration !== duration)
        throw new Error('Conflicting segment')
      return
    }
    if (
      !recording.initChecksum ||
      index !== recording.segmentCount ||
      (recording.finalCount !== undefined && index >= recording.finalCount) ||
      duration <= 0 ||
      duration > 15 ||
      !Number.isFinite(duration) ||
      recording.duration + duration > recording.maxDuration + 1
    )
      throw new Error('Invalid media timeline')
    await ctx.db.insert('mediaSegments', {
      recordingId: recording._id,
      index,
      duration,
      size,
      checksum,
    })
    const next = {
      ...recording,
      segmentCount: index + 1,
      duration: recording.duration + duration,
      updatedAt: Date.now(),
    }
    await ctx.db.patch(recording._id, {
      segmentCount: next.segmentCount,
      duration: next.duration,
      updatedAt: next.updatedAt,
    })
    await updatePlayable(ctx, next)
  },
})
export const finish = mutation({
  args: { recordingId: v.id('segmentRecordings'), segmentCount: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx)
    const recording = await ctx.db.get(args.recordingId)
    if (!recording || recording.userId !== userId) throw new Error('Forbidden')
    await linkedAccess(ctx, recording, userId)
    if (
      !Number.isInteger(args.segmentCount) ||
      args.segmentCount < 1 ||
      args.segmentCount > MAX_SEGMENTS ||
      args.segmentCount < recording.segmentCount ||
      (recording.finalCount !== undefined && recording.finalCount !== args.segmentCount)
    )
      throw new Error('Invalid final segment count')
    await ctx.db.patch(recording._id, { finalCount: args.segmentCount, updatedAt: Date.now() })
    await updatePlayable(ctx, { ...recording, finalCount: args.segmentCount })
    return { complete: recording.segmentCount === args.segmentCount }
  },
})
export const timeline = internalQuery({
  args: {
    recordingId: v.id('segmentRecordings'),
    userId: v.id('users'),
    index: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    requireSegmentMedia()
    const recording = await ctx.db.get(args.recordingId)
    if (!recording) throw new Error('Forbidden')
    await linkedAccess(ctx, recording, args.userId)
    if (
      args.index !== null &&
      (args.index < -1 || !Number.isInteger(args.index) || args.index >= recording.segmentCount)
    )
      throw new Error('Forbidden')
    const segments =
      args.index === null
        ? await ctx.db
            .query('mediaSegments')
            .withIndex('by_recording_index', (q) => q.eq('recordingId', recording._id))
            .take(MAX_SEGMENTS)
        : []
    return {
      complete: recording.status === 'ready',
      segments: segments.map(({ index, duration }) => ({ index, duration })),
    }
  },
})

export const cleanupPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    requireSegmentMedia()
    const page = await ctx.db.query('segmentRecordings').paginate({ cursor, numItems: 50 })
    const ids: Id<'segmentRecordings'>[] = []
    const interrupted: Id<'segmentRecordings'>[] = []
    for (const recording of page.page) {
      const owner = await ctx.db.get(recording.userId)
      const response = recording.responseId ? await ctx.db.get(recording.responseId) : null
      const source = recording.bondfireId
        ? await ctx.db.get(recording.bondfireId)
        : response
          ? await ctx.db.get(response.bondfireId)
          : null
      if (
        !owner ||
        owner.accountDeletionStatus ||
        !source ||
        (recording.responseId && !response) ||
        (source.expiresAt !== undefined && source.expiresAt <= Date.now()) ||
        recording.status === 'cancelled'
      )
        ids.push(recording._id)
      else if (
        recording.status === 'uploading' &&
        recording.createdAt < Date.now() - 7 * 86400_000
      ) {
        if (recording.initChecksum && recording.segmentCount > 0) interrupted.push(recording._id)
        else ids.push(recording._id)
      }
    }
    return { ids, interrupted, cursor: page.isDone ? null : page.continueCursor }
  },
})
/** End a long-interrupted recording at its durable prefix instead of deleting playable video. */
export const finalizeInterrupted = internalMutation({
  args: { recordingId: v.id('segmentRecordings') },
  handler: async (ctx, { recordingId }) => {
    requireSegmentMedia()
    const record = await ctx.db.get(recordingId)
    if (
      !record ||
      record.status !== 'uploading' ||
      record.createdAt >= Date.now() - 7 * 86400_000 ||
      !record.initChecksum ||
      !record.segmentCount
    )
      return
    try {
      await linkedAccess(ctx, record, record.userId)
    } catch {
      return // Deletion/revocation is handled by the next cleanup scan.
    }
    const finished = { ...record, finalCount: record.segmentCount, updatedAt: Date.now() }
    await ctx.db.patch(record._id, {
      finalCount: finished.finalCount,
      updatedAt: finished.updatedAt,
    })
    await updatePlayable(ctx, finished)
  },
})

export const revoke = internalMutation({
  args: { recordingId: v.id('segmentRecordings') },
  handler: async (ctx, { recordingId }) => {
    requireSegmentMedia()
    const record = await ctx.db.get(recordingId)
    if (record && record.status !== 'cancelled') {
      await ctx.db.patch(recordingId, { status: 'cancelled', updatedAt: Date.now() })
      const sourceId = record.responseId ?? record.bondfireId
      const source = sourceId && (await ctx.db.get(sourceId))
      if (source && source.segmentRecordingId === record._id) {
        if ('bondfireId' in source) await uncountResponse(ctx, source)
        await ctx.db.patch(source._id, { videoStatus: 'errored' })
      }
    }
  },
})
export const purge = internalMutation({
  args: { recordingId: v.id('segmentRecordings') },
  handler: async (ctx, { recordingId }) => {
    requireSegmentMedia()
    const tombstone = await ctx.db.get(recordingId)
    if (
      !tombstone ||
      tombstone.status !== 'cancelled' ||
      tombstone.updatedAt > Date.now() - 3600_000
    )
      return
    const segments = await ctx.db
      .query('mediaSegments')
      .withIndex('by_recording_index', (q) => q.eq('recordingId', recordingId))
      .take(MAX_SEGMENTS)
    for (const segment of segments) await ctx.db.delete(segment._id)
    if (await ctx.db.get(recordingId)) await ctx.db.delete(recordingId)
  },
})

export const cleanup = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    if (!isMediaEnabled()) return
    const page = await ctx.runQuery(internal.segmentMedia.cleanupPage, { cursor: cursor ?? null })
    for (const recordingId of page.interrupted) {
      await ctx.runMutation(internal.segmentMedia.finalizeInterrupted, { recordingId })
    }
    for (const recordingId of page.ids) {
      await ctx.runMutation(internal.segmentMedia.revoke, { recordingId })
      const response = await fetch(`${process.env.MEDIA_WORKER_URL}/v1/${recordingId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.MEDIA_WORKER_SECRET}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error('Media cleanup will retry')
      await ctx.runMutation(internal.segmentMedia.purge, { recordingId })
    }
    if (page.cursor)
      await ctx.scheduler.runAfter(0, internal.segmentMedia.cleanup, { cursor: page.cursor })
  },
})

/** Private caption delivery uses the same current membership/deletion checks as video. */
export const captions = internalQuery({
  args: { recordingId: v.id('segmentRecordings'), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireSegmentMedia()
    const recording = await ctx.db.get(args.recordingId)
    if (!recording) throw new Error('Forbidden')
    await linkedAccess(ctx, recording, args.userId)
    const id = recording.responseId ?? recording.bondfireId
    const record = id ? await ctx.db.get(id) : null
    if (!record?.captionsReadyAt) return { captionsVtt: null }
    const row = recording.responseId
      ? await ctx.db
          .query('videoTranscripts')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', recording.responseId))
          .first()
      : await ctx.db
          .query('videoTranscripts')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', recording.bondfireId))
          .first()
    return {
      captionsVtt: row?.segmentRecordingId === recording._id ? (row.captionsVtt ?? null) : null,
    }
  },
})
