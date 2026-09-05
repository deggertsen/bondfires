import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { isUserEligibleForCamp } from './agePolicy'
import { getUserIdIncludingDeleting } from './auth'
import { throwUserError } from './errors'
import {
  ACCOUNT_DELETION_BATCH_SIZE,
  ACCOUNT_DELETION_MAX_RETRY_DELAY_MS,
  ACCOUNT_DELETION_MEDIA_BATCH_SIZE,
  ACCOUNT_DELETION_USER_STAGES,
  type AccountDeletionUserStage,
  accountDeletionRetryDelay,
  collectMuxDeletionTargets,
  nextAccountDeletionStage,
} from './lib/accountDeletionPolicy'
import { uncountResponse } from './responseCounts'

const BATCH_SIZE = ACCOUNT_DELETION_BATCH_SIZE
const MEDIA_BATCH_SIZE = ACCOUNT_DELETION_MEDIA_BATCH_SIZE

type ContentKind = 'bondfire' | 'response' | 'live_session'
type MediaKind = 'asset' | 'live_stream' | 'direct_upload'

/**
 * Begin a durable deletion request. Sessions are revoked before this mutation
 * commits, and the media-first worker owns all subsequent destructive work.
 */
export const request = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    if (!userId) throwUserError('Not authenticated')

    const user = await ctx.db.get(userId)
    if (!user) throwUserError('Account not found')

    const existing = await ctx.db
      .query('accountDeletionJobs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .first()
    if (existing) {
      await ctx.scheduler.runAfter(0, internal.accountDeletion.run, { jobId: existing._id })
      return { accepted: true, alreadyRequested: true }
    }

    const now = Date.now()
    const jobId = await ctx.db.insert('accountDeletionJobs', {
      userId,
      status: 'inventory',
      inventoryStage: 'responses',
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
      profileStorageId: user.photoStorageId,
    })

    await ctx.db.patch(userId, {
      accountDeletionStatus: 'requested',
      accountDeletionRequestedAt: now,
      emailVerified: false,
      updatedAt: now,
    })

    // Revoke every session (including this one) before returning. Refresh
    // tokens and session-bound OAuth verifiers are removed along with them.
    const sessions = await ctx.db
      .query('authSessions')
      .withIndex('userId', (q) => q.eq('userId', userId))
      .collect()
    for (const session of sessions) {
      const refreshTokens = await ctx.db
        .query('authRefreshTokens')
        .withIndex('sessionId', (q) => q.eq('sessionId', session._id))
        .collect()
      for (const token of refreshTokens) await ctx.db.delete(token._id)

      const verifiers = await ctx.db
        .query('authVerifiers')
        .filter((q) => q.eq(q.field('sessionId'), session._id))
        .collect()
      for (const verifier of verifiers) await ctx.db.delete(verifier._id)
      await ctx.db.delete(session._id)
    }

    await ctx.scheduler.runAfter(0, internal.accountDeletion.run, { jobId })
    return { accepted: true, alreadyRequested: false }
  },
})

export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    if (!userId) return null
    return await ctx.db
      .query('accountDeletionJobs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .first()
  },
})

export const getJob = internalQuery({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
})

async function enqueueContent(
  ctx: MutationCtx,
  jobId: Id<'accountDeletionJobs'>,
  kind: ContentKind,
  recordId: string,
) {
  const existing = await ctx.db
    .query('accountDeletionContent')
    .withIndex('by_job_record', (q) =>
      q.eq('jobId', jobId).eq('kind', kind).eq('recordId', recordId),
    )
    .first()
  if (existing) return
  const now = Date.now()
  await ctx.db.insert('accountDeletionContent', {
    jobId,
    kind,
    recordId,
    mediaStatus: 'pending',
    databaseStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  })
}

export const inventoryBatch = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job?.userId || job.status !== 'inventory') return
    const userId = job.userId
    const now = Date.now()
    const stage = job.inventoryStage ?? 'responses'

    if (stage === 'responses') {
      const page = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .paginate({ cursor: job.inventoryCursor ?? null, numItems: BATCH_SIZE })
      for (const row of page.page) await enqueueContent(ctx, job._id, 'response', row._id)
      await ctx.db.patch(job._id, {
        inventoryStage: page.isDone ? 'bondfires' : 'responses',
        inventoryCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: now,
      })
      return
    }

    if (stage === 'bondfires') {
      const page = await ctx.db
        .query('bondfires')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .paginate({ cursor: job.inventoryCursor ?? null, numItems: BATCH_SIZE })
      for (const row of page.page) await enqueueContent(ctx, job._id, 'bondfire', row._id)
      await ctx.db.patch(job._id, {
        inventoryStage: page.isDone ? 'live_sessions' : 'bondfires',
        inventoryCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: now,
      })
      return
    }

    const page = await ctx.db
      .query('liveSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .paginate({ cursor: job.inventoryCursor ?? null, numItems: BATCH_SIZE })
    for (const row of page.page) await enqueueContent(ctx, job._id, 'live_session', row._id)
    await ctx.db.patch(job._id, {
      status: page.isDone ? 'media' : 'inventory',
      inventoryCursor: page.isDone ? undefined : page.continueCursor,
      updatedAt: now,
    })
    await ctx.db.patch(userId, { accountDeletionStatus: 'processing', updatedAt: now })
  },
})

async function enqueueMedia(
  ctx: MutationCtx,
  jobId: Id<'accountDeletionJobs'>,
  kind: MediaKind,
  externalId: string | undefined,
) {
  if (!externalId) return
  const existing = await ctx.db
    .query('accountDeletionMedia')
    .withIndex('by_job_external', (q) =>
      q.eq('jobId', jobId).eq('kind', kind).eq('externalId', externalId),
    )
    .first()
  if (existing) return
  const now = Date.now()
  await ctx.db.insert('accountDeletionMedia', {
    jobId,
    kind,
    externalId,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  })
}

async function enqueueVideoMedia(
  ctx: MutationCtx,
  jobId: Id<'accountDeletionJobs'>,
  video: Pick<Doc<'bondfires'>, 'muxUploadId' | 'muxAssetId' | 'muxLiveStreamId' | 'liveSessionId'>,
) {
  const live = video.liveSessionId ? await ctx.db.get(video.liveSessionId) : null
  const targets = collectMuxDeletionTargets(video, live)
  for (const uploadId of targets.directUploads)
    await enqueueMedia(ctx, jobId, 'direct_upload', uploadId)
  for (const liveStreamId of targets.liveStreams)
    await enqueueMedia(ctx, jobId, 'live_stream', liveStreamId)
  for (const assetId of targets.assets) await enqueueMedia(ctx, jobId, 'asset', assetId)
}

export const inventoryContentMedia = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const content = await ctx.db
      .query('accountDeletionContent')
      .withIndex('by_job_media', (q) => q.eq('jobId', args.jobId).eq('mediaStatus', 'pending'))
      .first()
    if (!content) return { found: false }
    const now = Date.now()

    if (content.kind === 'response') {
      const id = ctx.db.normalizeId('bondfireVideos', content.recordId)
      const video = id ? await ctx.db.get(id) : null
      if (video) await enqueueVideoMedia(ctx, args.jobId, video)
      await ctx.db.patch(content._id, { mediaStatus: 'inventoried', updatedAt: now })
      return { found: true }
    }

    if (content.kind === 'live_session') {
      const id = ctx.db.normalizeId('liveSessions', content.recordId)
      const live = id ? await ctx.db.get(id) : null
      if (live) {
        await enqueueMedia(ctx, args.jobId, 'live_stream', live.muxLiveStreamId)
        for (const assetId of [
          live.muxActiveAssetId,
          live.muxRecentAssetId,
          live.muxRecordedAssetId,
        ]) {
          await enqueueMedia(ctx, args.jobId, 'asset', assetId)
        }
      }
      await ctx.db.patch(content._id, { mediaStatus: 'inventoried', updatedAt: now })
      return { found: true }
    }

    const id = ctx.db.normalizeId('bondfires', content.recordId)
    const bondfire = id ? await ctx.db.get(id) : null
    if (!bondfire) {
      await ctx.db.patch(content._id, { mediaStatus: 'inventoried', updatedAt: now })
      return { found: true }
    }

    const children = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
      .paginate({ cursor: content.childCursor ?? null, numItems: BATCH_SIZE })
    for (const child of children.page) {
      await enqueueContent(ctx, args.jobId, 'response', child._id)
      await enqueueVideoMedia(ctx, args.jobId, child)
    }
    if (children.isDone) await enqueueVideoMedia(ctx, args.jobId, bondfire)
    await ctx.db.patch(content._id, {
      childCursor: children.isDone ? undefined : children.continueCursor,
      mediaStatus: children.isDone ? 'inventoried' : 'pending',
      updatedAt: now,
    })
    return { found: true }
  },
})

export const listPendingMedia = internalQuery({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) =>
    await ctx.db
      .query('accountDeletionMedia')
      .withIndex('by_job_status', (q) => q.eq('jobId', args.jobId).eq('status', 'pending'))
      .take(MEDIA_BATCH_SIZE),
})

export const markMediaResult = internalMutation({
  args: {
    mediaId: v.id('accountDeletionMedia'),
    result: v.union(v.literal('deleted'), v.literal('missing'), v.literal('failed')),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.mediaId)
    if (!row) return
    await ctx.db.patch(row._id, {
      status: args.result === 'failed' ? 'pending' : args.result,
      attempts: row.attempts + 1,
      lastError: args.error,
      updatedAt: Date.now(),
    })
  },
})

function muxConfig() {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET
  if (!tokenId || !tokenSecret) throw new Error('Mux credentials are not configured')
  return { authorization: `Basic ${btoa(`${tokenId}:${tokenSecret}`)}` }
}

async function muxRequest(path: string, method: 'GET' | 'DELETE' | 'PUT') {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(`https://api.mux.com/video/v1/${path}`, {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: muxConfig().authorization },
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function deleteMux(kind: MediaKind, externalId: string) {
  if (kind === 'direct_upload') {
    const cancelled = await muxRequest(`uploads/${externalId}/cancel`, 'PUT')
    if (cancelled.ok) return 'deleted' as const
    if (cancelled.status === 404) return 'missing' as const

    // Cancellation only succeeds while waiting. If the upload won the race,
    // resolve the asset it created and delete that asset before proceeding.
    const lookup = await muxRequest(`uploads/${externalId}`, 'GET')
    if (lookup.status === 404) return 'missing' as const
    if (!lookup.ok) throw new Error(`Mux upload lookup failed (${lookup.status})`)
    const payload = (await lookup.json()) as {
      data?: { status?: string; asset_id?: string }
    }
    if (payload.data?.asset_id) {
      const asset = await muxRequest(`assets/${payload.data.asset_id}`, 'DELETE')
      if (!asset.ok && asset.status !== 404)
        throw new Error(`Mux asset deletion failed (${asset.status})`)
      return 'deleted' as const
    }
    if (['cancelled', 'timed_out', 'errored'].includes(payload.data?.status ?? '')) {
      return 'missing' as const
    }
    throw new Error(`Mux upload could not be cancelled (${payload.data?.status ?? 'unknown'})`)
  }
  const resource = kind === 'asset' ? 'assets' : 'live-streams'
  const response = await muxRequest(`${resource}/${externalId}`, 'DELETE')
  if (response.status === 404) return 'missing' as const
  if (!response.ok) throw new Error(`Mux ${resource} deletion failed (${response.status})`)
  return 'deleted' as const
}

export const deleteMediaBatch = internalAction({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args): Promise<{ processed: number; failures: number }> => {
    const rows: Doc<'accountDeletionMedia'>[] = await ctx.runQuery(
      internal.accountDeletion.listPendingMedia,
      args,
    )
    let failures = 0
    for (const row of rows) {
      try {
        const result = await deleteMux(row.kind, row.externalId)
        await ctx.runMutation(internal.accountDeletion.markMediaResult, {
          mediaId: row._id,
          result,
        })
      } catch (error) {
        failures += 1
        await ctx.runMutation(internal.accountDeletion.markMediaResult, {
          mediaId: row._id,
          result: 'failed',
          error:
            error instanceof Error ? error.message.slice(0, 500) : 'Unknown Mux deletion error',
        })
      }
    }
    return { processed: rows.length, failures }
  },
})

export const transitionToDatabase = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) return
    await ctx.db.patch(job._id, {
      status: 'database',
      cleanupStage: ACCOUNT_DELETION_USER_STAGES[0],
      attempts: 0,
      lastError: undefined,
      retryPhase: undefined,
      updatedAt: Date.now(),
    })
  },
})

async function deleteRows(rows: Array<{ _id: Id<TableNames> }>, ctx: MutationCtx) {
  for (const row of rows) await ctx.db.delete(row._id)
}

async function deleteFamilyConnectionAndGrants(
  ctx: MutationCtx,
  connectionId: Id<'familyConnections'>,
) {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_family_connection_status', (q) => q.eq('familyConnectionId', connectionId))
    .take(BATCH_SIZE)
  await deleteRows(participants, ctx)
  if (participants.length === BATCH_SIZE) return
  await ctx.db.delete(connectionId)
}

async function findEligibleCampSuccessor(
  ctx: MutationCtx,
  camp: Doc<'camps'>,
  deletingUserId: Id<'users'>,
) {
  let disabledCount = 0
  const now = Date.now()

  for (const role of ['moderator', 'member'] as const) {
    const candidates = await ctx.db
      .query('campMembers')
      .withIndex('by_camp_status_role', (q) =>
        q.eq('campId', camp._id).eq('status', 'active').eq('role', role),
      )
      .take(BATCH_SIZE)

    for (const candidate of candidates) {
      const candidateUser =
        candidate.userId === deletingUserId ? null : await ctx.db.get(candidate.userId)
      if (candidateUser && isUserEligibleForCamp(candidateUser, camp)) {
        if (disabledCount > 0) {
          await ctx.db.patch(camp._id, {
            activeMemberCount: Math.max(0, (camp.activeMemberCount ?? 0) - disabledCount),
            updatedAt: now,
          })
        }
        return { successor: candidate, retry: false }
      }

      await ctx.db.patch(candidate._id, {
        status: 'rejected',
        moderationReason: 'Age-group access changed; membership disabled automatically.',
        rejectedAt: now,
        updatedAt: now,
      })
      disabledCount += 1
    }

    // Drain a full page of stale rows before deciding that this role has no
    // eligible successor. This keeps account deletion bounded and resumable.
    if (candidates.length === BATCH_SIZE) {
      await ctx.db.patch(camp._id, {
        activeMemberCount: Math.max(0, (camp.activeMemberCount ?? 0) - disabledCount),
        updatedAt: now,
      })
      return { successor: null, retry: true }
    }
  }

  if (disabledCount > 0) {
    await ctx.db.patch(camp._id, {
      activeMemberCount: Math.max(0, (camp.activeMemberCount ?? 0) - disabledCount),
      updatedAt: now,
    })
  }
  return { successor: null, retry: false }
}

const RESPONSE_STAGES = [
  'transcripts',
  'reports',
  'reactions',
  'presence',
  'watch',
  'deliveries',
  'row',
] as const
const BONDFIRE_STAGES = [
  'children',
  'transcripts',
  'reports',
  'reactions',
  'presence',
  'watch',
  'deliveries',
  'thread_deliveries',
  'notifications',
  'reads',
  'participants',
  'invite_claims',
  'invite_codes',
  'invites',
  'user_pins',
  'row',
] as const

function nextContentStage(stages: readonly string[], current: string | undefined) {
  if (!current) return stages[0]
  const index = stages.indexOf(current)
  return stages[Math.min(index + 1, stages.length - 1)]
}

export const deleteContentBatch = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const response = await ctx.db
      .query('accountDeletionContent')
      .withIndex('by_job_database_kind', (q) =>
        q.eq('jobId', args.jobId).eq('databaseStatus', 'pending').eq('kind', 'response'),
      )
      .first()
    const candidates = await ctx.db
      .query('accountDeletionContent')
      .withIndex('by_job_database', (q) =>
        q.eq('jobId', args.jobId).eq('databaseStatus', 'pending'),
      )
      .take(BATCH_SIZE)
    const content = response ?? candidates[0]
    if (!content) return { found: false }
    const now = Date.now()

    if (content.kind === 'live_session') {
      const id = ctx.db.normalizeId('liveSessions', content.recordId)
      if (id && (await ctx.db.get(id))) await ctx.db.delete(id)
      await ctx.db.patch(content._id, { databaseStatus: 'deleted', updatedAt: now })
      return { found: true }
    }

    if (content.kind === 'response') {
      const id = ctx.db.normalizeId('bondfireVideos', content.recordId)
      const video = id ? await ctx.db.get(id) : null
      if (!video) {
        await ctx.db.patch(content._id, { databaseStatus: 'deleted', updatedAt: now })
        return { found: true }
      }
      const stage = content.cleanupStage ?? RESPONSE_STAGES[0]
      let rows: Array<{ _id: Id<TableNames> }> = []
      if (stage === 'transcripts')
        rows = await ctx.db
          .query('videoTranscripts')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', video._id))
          .take(BATCH_SIZE)
      if (stage === 'reports')
        rows = await ctx.db
          .query('reports')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', video._id))
          .take(BATCH_SIZE)
      if (stage === 'reactions')
        rows = await ctx.db
          .query('videoReactions')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', video._id))
          .take(BATCH_SIZE)
      if (stage === 'presence')
        rows = await ctx.db
          .query('presence')
          .withIndex('by_video', (q) => q.eq('videoType', 'response').eq('videoId', video._id))
          .take(BATCH_SIZE)
      if (stage === 'watch')
        rows = await ctx.db
          .query('watchEvents')
          .withIndex('by_video', (q) => q.eq('videoId', video._id))
          .take(BATCH_SIZE)
      if (stage === 'deliveries')
        rows = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_video_user', (q) => q.eq('videoKey', video._id))
          .take(BATCH_SIZE)
      await deleteRows(rows, ctx)
      if (rows.length === BATCH_SIZE) return { found: true }
      if (stage === 'row') {
        await uncountResponse(ctx, video)
        if (video.liveSessionId && (await ctx.db.get(video.liveSessionId)))
          await ctx.db.delete(video.liveSessionId)
        await ctx.db.delete(video._id)
        await ctx.db.patch(content._id, { databaseStatus: 'deleted', updatedAt: now })
      } else {
        await ctx.db.patch(content._id, {
          cleanupStage: nextContentStage(RESPONSE_STAGES, stage),
          updatedAt: now,
        })
      }
      return { found: true }
    }

    const id = ctx.db.normalizeId('bondfires', content.recordId)
    const bondfire = id ? await ctx.db.get(id) : null
    if (!bondfire) {
      await ctx.db.patch(content._id, { databaseStatus: 'deleted', updatedAt: now })
      return { found: true }
    }
    const stage = content.cleanupStage ?? BONDFIRE_STAGES[0]
    let rows: Array<{ _id: Id<TableNames> }> = []
    if (stage === 'children') {
      const child = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .first()
      if (child) {
        await enqueueContent(ctx, args.jobId, 'response', child._id)
        return { found: true }
      }
    }
    if (stage === 'user_pins') {
      const users = await ctx.db
        .query('users')
        .paginate({ cursor: content.childCursor ?? null, numItems: BATCH_SIZE })
      for (const user of users.page) {
        if (!user.pinnedBondfireIds?.includes(bondfire._id)) continue
        await ctx.db.patch(user._id, {
          pinnedBondfireIds: user.pinnedBondfireIds.filter((pinnedId) => pinnedId !== bondfire._id),
          updatedAt: now,
        })
      }
      await ctx.db.patch(content._id, {
        childCursor: users.isDone ? undefined : users.continueCursor,
        cleanupStage: users.isDone ? nextContentStage(BONDFIRE_STAGES, stage) : stage,
        updatedAt: now,
      })
      return { found: true }
    }
    if (stage === 'transcripts')
      rows = await ctx.db
        .query('videoTranscripts')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'reports')
      rows = await ctx.db
        .query('reports')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'reactions')
      rows = await ctx.db
        .query('videoReactions')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'presence')
      rows = await ctx.db
        .query('presence')
        .withIndex('by_video', (q) => q.eq('videoType', 'bondfire').eq('videoId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'watch')
      rows = await ctx.db
        .query('watchEvents')
        .withIndex('by_video', (q) => q.eq('videoId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'deliveries')
      rows = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_video_user', (q) => q.eq('videoKey', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'thread_deliveries')
      rows = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_thread', (q) => q.eq('threadKey', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'notifications')
      rows = await ctx.db
        .query('notifications')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'reads')
      rows = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'participants')
      rows = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'invite_claims')
      rows = await ctx.db
        .query('inviteClaims')
        .withIndex('by_bondfire_claimer', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'invite_codes')
      rows = await ctx.db
        .query('inviteCodes')
        .withIndex('by_parent', (q) => q.eq('parentType', 'bondfire').eq('parentId', bondfire._id))
        .take(BATCH_SIZE)
    if (stage === 'invites')
      rows = await ctx.db
        .query('bondfireInvites')
        .withIndex('by_bondfire_recipient', (q) => q.eq('bondfireId', bondfire._id))
        .take(BATCH_SIZE)
    await deleteRows(rows, ctx)
    if (rows.length === BATCH_SIZE) return { found: true }
    if (stage === 'row') {
      if (bondfire.liveSessionId && (await ctx.db.get(bondfire.liveSessionId)))
        await ctx.db.delete(bondfire.liveSessionId)
      await ctx.db.delete(bondfire._id)
      await ctx.db.patch(content._id, { databaseStatus: 'deleted', updatedAt: now })
    } else {
      await ctx.db.patch(content._id, {
        cleanupStage: nextContentStage(BONDFIRE_STAGES, stage),
        updatedAt: now,
      })
    }
    return { found: true }
  },
})

async function advanceJob(ctx: MutationCtx, job: Doc<'accountDeletionJobs'>) {
  await ctx.db.patch(job._id, {
    cleanupStage: nextAccountDeletionStage(job.cleanupStage),
    updatedAt: Date.now(),
  })
}

async function deleteUserRows(ctx: MutationCtx, rows: Array<{ _id: Id<TableNames> }>) {
  await deleteRows(rows, ctx)
  return rows.length === BATCH_SIZE
}

async function retainPurchaseRecord(
  ctx: MutationCtx,
  row: Doc<'subscriptions'> | Doc<'consumablePurchases'>,
  source: 'subscription' | 'consumable',
) {
  if (!row.storeTransactionId && !row.storeOriginalTransactionId && !row.storePurchaseToken) return
  await ctx.db.insert('deletedAccountPurchaseRecords', {
    source,
    platform: row.platform,
    storeProductId: row.storeProductId,
    storeTransactionId: row.storeTransactionId,
    storeOriginalTransactionId: row.storeOriginalTransactionId,
    storePurchaseToken: row.storePurchaseToken,
    deletedAt: Date.now(),
  })
}

export const cleanupUserBatch = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job?.userId) return { completed: job?.status === 'completed' }
    const userId = job.userId
    const user = await ctx.db.get(userId)
    if (!user) {
      await ctx.db.patch(job._id, {
        userId: undefined,
        status: 'completed',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
      return { completed: true }
    }
    const stage = (job.cleanupStage ?? ACCOUNT_DELETION_USER_STAGES[0]) as AccountDeletionUserStage
    let rows: Array<{ _id: Id<TableNames> }> = []

    if (stage === 'owned_camps') {
      const camp = await ctx.db
        .query('camps')
        .withIndex('by_owner', (q) => q.eq('ownerId', userId))
        .first()
      if (camp) {
        const { successor, retry } = await findEligibleCampSuccessor(ctx, camp, userId)
        if (retry) return { completed: false }
        if (successor) {
          const successorUser = await ctx.db.get(successor.userId)
          await ctx.db.patch(successor._id, { role: 'owner', updatedAt: Date.now() })
          await ctx.db.patch(camp._id, {
            ownerId: successor.userId,
            ownerDisplayName: successorUser?.displayName ?? successorUser?.name,
            updatedAt: Date.now(),
          })
        } else {
          await ctx.db.patch(camp._id, {
            ownerId: undefined,
            ownerDisplayName: undefined,
            status: camp.isLaunchCamp ? camp.status : 'archived',
            archivedAt: camp.isLaunchCamp ? camp.archivedAt : Date.now(),
            updatedAt: Date.now(),
          })
        }
        return { completed: false }
      }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'camp_members') {
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
      for (const membership of memberships) {
        const camp = await ctx.db.get(membership.campId)
        if (camp && membership.status === 'active') {
          await ctx.db.patch(camp._id, {
            activeMemberCount: Math.max(0, (camp.activeMemberCount ?? 1) - 1),
            updatedAt: Date.now(),
          })
        }
        await ctx.db.delete(membership._id)
      }
      if (memberships.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'invite_codes')
      rows = await ctx.db
        .query('inviteCodes')
        .withIndex('by_created_by', (q) => q.eq('createdBy', userId))
        .take(BATCH_SIZE)
    if (stage === 'invite_claims_sender')
      rows = await ctx.db
        .query('inviteClaims')
        .withIndex('by_sender', (q) => q.eq('senderId', userId))
        .take(BATCH_SIZE)
    if (stage === 'invite_claims_claimer')
      rows = await ctx.db
        .query('inviteClaims')
        .withIndex('by_claimer', (q) => q.eq('claimerId', userId))
        .take(BATCH_SIZE)
    if (stage === 'notifications')
      rows = await ctx.db
        .query('notifications')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'slot_transactions')
      rows = await ctx.db
        .query('campSlotTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'personal_participants')
      rows = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'personal_removed_by') {
      const participants = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_removed_by', (q) => q.eq('removedBy', userId))
        .take(BATCH_SIZE)
      for (const participant of participants) {
        await ctx.db.patch(participant._id, { removedBy: undefined, updatedAt: Date.now() })
      }
      if (participants.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'family_connections_first') {
      const connection = await ctx.db
        .query('familyConnections')
        .withIndex('by_first_status', (q) => q.eq('firstUserId', userId))
        .first()
      if (connection) {
        await deleteFamilyConnectionAndGrants(ctx, connection._id)
        return { completed: false }
      }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'family_connections_second') {
      const connection = await ctx.db
        .query('familyConnections')
        .withIndex('by_second_status', (q) => q.eq('secondUserId', userId))
        .first()
      if (connection) {
        await deleteFamilyConnectionAndGrants(ctx, connection._id)
        return { completed: false }
      }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'personal_camps')
      rows = await ctx.db
        .query('personalCamps')
        .withIndex('by_owner', (q) => q.eq('ownerId', userId))
        .take(BATCH_SIZE)
    if (stage === 'reconciliation')
      rows = await ctx.db
        .query('reconciliationLog')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'tier_target')
      rows = await ctx.db
        .query('tierAuditLog')
        .withIndex('by_target', (q) => q.eq('targetUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'tier_admin')
      rows = await ctx.db
        .query('tierAuditLog')
        .withIndex('by_admin', (q) => q.eq('adminUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'admin_audit')
      rows = await ctx.db
        .query('adminAuditLog')
        .withIndex('by_admin', (q) => q.eq('adminId', userId))
        .take(BATCH_SIZE)
    if (stage === 'admin_audit_target')
      rows = await ctx.db
        .query('adminAuditLog')
        .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', userId))
        .take(BATCH_SIZE)
    if (stage === 'admin_audit_subject')
      rows = await ctx.db
        .query('adminAuditLog')
        .withIndex('by_subject_user', (q) => q.eq('subjectUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'moderated_bondfires') {
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_moderated_by', (q) => q.eq('moderatedBy', userId))
        .take(BATCH_SIZE)
      for (const bondfire of bondfires) {
        await ctx.db.patch(bondfire._id, { moderatedBy: undefined, updatedAt: Date.now() })
      }
      if (bondfires.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'moderated_responses') {
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_moderated_by', (q) => q.eq('moderatedBy', userId))
        .take(BATCH_SIZE)
      for (const response of responses) {
        await ctx.db.patch(response._id, { moderatedBy: undefined })
      }
      if (responses.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'reports_reviewer') {
      const reports = await ctx.db
        .query('reports')
        .withIndex('by_reviewed_by', (q) => q.eq('reviewedBy', userId))
        .take(BATCH_SIZE)
      for (const report of reports) {
        await ctx.db.patch(report._id, { reviewedBy: undefined })
      }
      if (reports.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }
    if (stage === 'thread_reads')
      rows = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'pins_owned')
      rows = await ctx.db
        .query('closeCirclePins')
        .withIndex('by_owner', (q) => q.eq('ownerId', userId))
        .take(BATCH_SIZE)
    if (stage === 'pins_incoming')
      rows = await ctx.db
        .query('closeCirclePins')
        .withIndex('by_pinned', (q) => q.eq('pinnedUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'watch_events')
      rows = await ctx.db
        .query('watchEvents')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'device_tokens')
      rows = await ctx.db
        .query('deviceTokens')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'notification_deliveries')
      rows = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_user_thread', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'reports_reporter')
      rows = await ctx.db
        .query('reports')
        .withIndex('by_reporter', (q) => q.eq('reporterUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'reports_owner')
      rows = await ctx.db
        .query('reports')
        .withIndex('by_video_owner', (q) => q.eq('videoOwnerId', userId))
        .take(BATCH_SIZE)
    if (stage === 'client_logs')
      rows = await ctx.db
        .query('clientLogs')
        .withIndex('by_log_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'client_log_rate_limit')
      rows = await ctx.db
        .query('clientLogRateLimits')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'invites_sender')
      rows = await ctx.db
        .query('bondfireInvites')
        .withIndex('by_sender', (q) => q.eq('senderId', userId))
        .take(BATCH_SIZE)
    if (stage === 'invites_recipient')
      rows = await ctx.db
        .query('bondfireInvites')
        .withIndex('by_recipient', (q) => q.eq('recipientId', userId))
        .take(BATCH_SIZE)
    if (stage === 'blocks_outgoing')
      rows = await ctx.db
        .query('userBlocks')
        .withIndex('by_blocker', (q) => q.eq('blockerId', userId))
        .take(BATCH_SIZE)
    if (stage === 'blocks_incoming')
      rows = await ctx.db
        .query('userBlocks')
        .withIndex('by_blocked', (q) => q.eq('blockedUserId', userId))
        .take(BATCH_SIZE)
    if (stage === 'reactions')
      rows = await ctx.db
        .query('videoReactions')
        .withIndex('by_user_created', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
    if (stage === 'presence')
      rows = await ctx.db
        .query('presence')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)

    if (stage === 'subscriptions' || stage === 'consumable_purchases') {
      if (stage === 'subscriptions') {
        const purchases = await ctx.db
          .query('subscriptions')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .take(BATCH_SIZE)
        for (const purchase of purchases) {
          await retainPurchaseRecord(ctx, purchase, 'subscription')
          await ctx.db.delete(purchase._id)
        }
        if (purchases.length === BATCH_SIZE) return { completed: false }
      } else {
        const purchases = await ctx.db
          .query('consumablePurchases')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .take(BATCH_SIZE)
        for (const purchase of purchases) {
          await retainPurchaseRecord(ctx, purchase, 'consumable')
          await ctx.db.delete(purchase._id)
        }
        if (purchases.length === BATCH_SIZE) return { completed: false }
      }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'auth_accounts') {
      const accounts = await ctx.db
        .query('authAccounts')
        .withIndex('userIdAndProvider', (q) => q.eq('userId', userId))
        .take(BATCH_SIZE)
      for (const account of accounts) {
        const codes = await ctx.db
          .query('authVerificationCodes')
          .withIndex('accountId', (q) => q.eq('accountId', account._id))
          .collect()
        for (const code of codes) await ctx.db.delete(code._id)
        await ctx.db.delete(account._id)
      }
      if (accounts.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'auth_rate_limit') {
      if (user.email) {
        const email = user.email
        const rateLimits = await ctx.db
          .query('authRateLimits')
          .withIndex('identifier', (q) => q.eq('identifier', email))
          .take(BATCH_SIZE)
        await deleteRows(rateLimits, ctx)
        if (rateLimits.length === BATCH_SIZE) return { completed: false }
      }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'queue_content') {
      const queue = await ctx.db
        .query('accountDeletionContent')
        .withIndex('by_job_database', (q) => q.eq('jobId', job._id))
        .take(BATCH_SIZE)
      await deleteRows(queue, ctx)
      if (queue.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'queue_media') {
      const queue = await ctx.db
        .query('accountDeletionMedia')
        .withIndex('by_job_status', (q) => q.eq('jobId', job._id))
        .take(BATCH_SIZE)
      await deleteRows(queue, ctx)
      if (queue.length === BATCH_SIZE) return { completed: false }
      await advanceJob(ctx, job)
      return { completed: false }
    }

    if (stage === 'finalize') {
      if (job.profileStorageId) await ctx.storage.delete(job.profileStorageId)
      await ctx.db.delete(userId)
      await ctx.db.patch(job._id, {
        userId: undefined,
        profileStorageId: undefined,
        status: 'completed',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
      return { completed: true }
    }

    if (await deleteUserRows(ctx, rows)) return { completed: false }
    await advanceJob(ctx, job)
    return { completed: false }
  },
})

export const noteRetry = internalMutation({
  args: { jobId: v.id('accountDeletionJobs'), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) return 0
    const attempts = job.attempts + 1
    const retryPhase =
      job.status === 'inventory' || job.status === 'media' || job.status === 'database'
        ? job.status
        : (job.retryPhase ?? 'inventory')
    await ctx.db.patch(job._id, {
      status: 'retrying',
      retryPhase,
      attempts,
      lastError: args.error.slice(0, 500),
      updatedAt: Date.now(),
    })
    if (job.userId) {
      const user = await ctx.db.get(job.userId)
      if (user) await ctx.db.patch(user._id, { accountDeletionStatus: 'retrying' })
    }
    return accountDeletionRetryDelay(attempts)
  },
})

export const resume = internalMutation({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'retrying') return
    await ctx.db.patch(job._id, {
      status: job.retryPhase ?? 'inventory',
      retryPhase: undefined,
      updatedAt: Date.now(),
    })
  },
})

export const run = internalAction({
  args: { jobId: v.id('accountDeletionJobs') },
  handler: async (ctx, args) => {
    try {
      let job = await ctx.runQuery(internal.accountDeletion.getJob, args)
      if (!job || job.status === 'completed') return
      if (job.status === 'retrying') {
        await ctx.runMutation(internal.accountDeletion.resume, args)
        job = await ctx.runQuery(internal.accountDeletion.getJob, args)
        if (!job) return
      }
      if (job.status === 'inventory') {
        await ctx.runMutation(internal.accountDeletion.inventoryBatch, args)
      } else if (job.status === 'media') {
        const inventoried = await ctx.runMutation(
          internal.accountDeletion.inventoryContentMedia,
          args,
        )
        if (!inventoried.found) {
          const media = await ctx.runAction(internal.accountDeletion.deleteMediaBatch, args)
          if (media.failures > 0) throw new Error(`${media.failures} Mux deletion(s) failed`)
          if (media.processed === 0)
            await ctx.runMutation(internal.accountDeletion.transitionToDatabase, args)
        }
      } else if (job.status === 'database') {
        const content = await ctx.runMutation(internal.accountDeletion.deleteContentBatch, args)
        if (!content.found) await ctx.runMutation(internal.accountDeletion.cleanupUserBatch, args)
      }
      const latest = await ctx.runQuery(internal.accountDeletion.getJob, args)
      if (latest && latest.status !== 'completed') {
        await ctx.scheduler.runAfter(0, internal.accountDeletion.run, args)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown account deletion error'
      const delay = await ctx.runMutation(internal.accountDeletion.noteRetry, {
        jobId: args.jobId,
        error: message,
      })
      await ctx.scheduler.runAfter(delay, internal.accountDeletion.run, args)
    }
  },
})

/** Safety net for scheduler/provider outages. Idempotently requeues stale jobs. */
export const resumeStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ACCOUNT_DELETION_MAX_RETRY_DELAY_MS
    const statuses = ['inventory', 'media', 'database', 'retrying'] as const
    let scheduled = 0
    for (const status of statuses) {
      const jobs = await ctx.db
        .query('accountDeletionJobs')
        .withIndex('by_status_updated', (q) => q.eq('status', status).lt('updatedAt', cutoff))
        .take(BATCH_SIZE)
      for (const job of jobs) {
        await ctx.scheduler.runAfter(0, internal.accountDeletion.run, { jobId: job._id })
        scheduled += 1
      }
    }
    return { scheduled }
  },
})
