/**
 * Bondfire-level video retention enforcement.
 *
 * Replaces the old per-video personalCampRetention system with a simpler model:
 * a bondfire (spark + all responses) stays alive as long as ANY video within it
 * was created within the last 30 days. Once the newest video crosses the 30-day
 * threshold, the entire bondfire is deleted — spark, all responses, live sessions,
 * and Mux assets.
 *
 * Premium and Pro owners have unlimited retention and are always skipped.
 * Free users who previously had Plus also get 30-day expiry (tier checked at
 * enforcement time, not creation time).
 *
 * Live bondfires (spark or any response currently live/streaming) are skipped
 * to avoid interrupting active broadcasts.
 *
 * TODO: As traffic grows, increase cron frequency beyond daily to avoid large
 * batch backlogs (e.g. run every 6 hours, then every hour).
 */

import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server'
import {
  BONDFIRE_RETENTION_MS,
  getEntitlementSubscriptionTier,
  type SubscriptionTier,
  TIER_RANK,
} from './entitlements'
import { deleteBondfireInviteArtifacts } from './inviteArtifacts'
import { canStartMaintenanceRun, isExpectedMaintenancePage } from './lib/maintenanceRuns'
import { boundedInteger } from './lib/queryBounds'

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'

const RETENTION_CANDIDATE_BATCH_SIZE = 5
const RETENTION_CANDIDATE_BATCH_MAX = 10
const RETENTION_RESPONSE_READ_MAX = 100
const RETENTION_SWEEP_LEASE_MS = 6 * 60 * 60 * 1000
const RETENTION_SWEEP_JOB = 'bondfire-retention'

type ExpiredBondfire = {
  bondfireId: Id<'bondfires'>
  muxAssetIds: string[]
}

type RetentionStats = {
  bondfiresChecked: number
  bondfiresSkippedLive: number
  bondfiresSkippedUnlimitedRetention: number
  bondfiresSkippedNotExpired: number
  bondfiresSkippedOversized: number
}

type ExpiredBondfireBatch = {
  expired: ExpiredBondfire[]
  stats: RetentionStats
  continueCursor: string
  isDone: boolean
}

type RetentionResult = RetentionStats & {
  bondfiresDeleted: number
  bondfiresSkippedAssetDrift: number
  responseVideosDeleted: number
  muxAssetsDeleted: number
  muxAssetsMissing: number
  muxAssetsFailed: number
}

const EMPTY_RETENTION_RESULT: RetentionResult = {
  bondfiresChecked: 0,
  bondfiresSkippedLive: 0,
  bondfiresSkippedUnlimitedRetention: 0,
  bondfiresSkippedNotExpired: 0,
  bondfiresSkippedOversized: 0,
  bondfiresDeleted: 0,
  bondfiresSkippedAssetDrift: 0,
  responseVideosDeleted: 0,
  muxAssetsDeleted: 0,
  muxAssetsMissing: 0,
  muxAssetsFailed: 0,
}

function readRetentionResult(value: unknown): RetentionResult {
  if (!value || typeof value !== 'object') return { ...EMPTY_RETENTION_RESULT }
  const result = value as Partial<RetentionResult>
  return Object.fromEntries(
    Object.entries(EMPTY_RETENTION_RESULT).map(([key, fallback]) => [
      key,
      result[key as keyof RetentionResult] ?? fallback,
    ]),
  ) as RetentionResult
}

// ── Helpers ──

function tierHasUnlimitedRetention(tier: SubscriptionTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.premium
}

function getMuxAuthorizationHeader(): string {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error(
      'Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET in Convex environment variables.',
    )
  }

  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`
}

async function deleteMuxAsset(assetId: string): Promise<'deleted' | 'missing'> {
  const response = await fetch(`${MUX_API_BASE_URL}/assets/${assetId}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: getMuxAuthorizationHeader(),
    },
  })

  if (response.status === 404) {
    return 'missing'
  }

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Mux asset delete failed: ${response.status} ${message}`)
  }

  return 'deleted'
}

function isLiveVideo(record: { videoStatus?: string }): boolean {
  return record.videoStatus === 'live'
}

function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}): boolean {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

function collectMuxAssetIds(records: Array<{ muxAssetId?: string }>): string[] {
  return [
    ...new Set(
      records
        .map((record) => record.muxAssetId)
        .filter((assetId): assetId is string => assetId !== undefined),
    ),
  ]
}

async function deleteWatchEventsForVideo(ctx: MutationCtx, videoId: string) {
  const watchEvents = await ctx.db
    .query('watchEvents')
    .withIndex('by_video', (q) => q.eq('videoId', videoId))
    .collect()

  for (const watchEvent of watchEvents) {
    await ctx.db.delete(watchEvent._id)
  }
}

async function deleteLiveSessionIfExists(ctx: MutationCtx, liveSessionId: Id<'liveSessions'>) {
  const liveSession = await ctx.db.get(liveSessionId)
  if (liveSession) {
    await ctx.db.delete(liveSessionId)
  }
}

// ── Internal Query: Find expired bondfires ──

export const findExpiredBondfires = internalQuery({
  args: { paginationOpts: paginationOptsValidator, cutoff: v.number() },
  handler: async (ctx, args): Promise<ExpiredBondfireBatch> => {
    const stats: RetentionStats = {
      bondfiresChecked: 0,
      bondfiresSkippedLive: 0,
      bondfiresSkippedUnlimitedRetention: 0,
      bondfiresSkippedNotExpired: 0,
      bondfiresSkippedOversized: 0,
    }
    const numItems = boundedInteger(args.paginationOpts.numItems, {
      defaultValue: RETENTION_CANDIDATE_BATCH_SIZE,
      min: 1,
      max: RETENTION_CANDIDATE_BATCH_MAX,
      name: 'paginationOpts.numItems',
    })
    const candidates = await ctx.db
      .query('bondfires')
      .withIndex('by_updated', (q) => q.lt('updatedAt', args.cutoff))
      .order('asc')
      .paginate({ ...args.paginationOpts, numItems })
    const expired: ExpiredBondfire[] = []

    for (const bondfire of candidates.page) {
      stats.bondfiresChecked++

      // Skip live bondfires
      if (isLiveVideo(bondfire)) {
        stats.bondfiresSkippedLive++
        continue
      }

      // Check owner's tier
      const tier = await getEntitlementSubscriptionTier(ctx, bondfire.userId)
      if (tierHasUnlimitedRetention(tier)) {
        stats.bondfiresSkippedUnlimitedRetention++
        continue
      }

      // Collect all response videos for this bondfire
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .take(RETENTION_RESPONSE_READ_MAX + 1)
      if (responses.length > RETENTION_RESPONSE_READ_MAX) {
        stats.bondfiresSkippedOversized++
        continue
      }

      // Check if any response is currently live
      const anyResponseLive = responses.some(isLiveVideo)
      if (anyResponseLive) {
        stats.bondfiresSkippedLive++
        continue
      }

      // updatedAt is bumped when responses are added. Retain the defensive
      // check for legacy rows whose timestamp may not reflect their responses.
      const newestResponseAt = responses.reduce(
        (latest, response) => Math.max(latest, response.createdAt),
        0,
      )
      if (Math.max(bondfire.updatedAt, newestResponseAt) >= args.cutoff) {
        stats.bondfiresSkippedNotExpired++
        continue
      }

      // Expired — collect all Mux asset IDs and record IDs for deletion
      const muxAssetIds: string[] = []
      if (bondfire.muxAssetId) {
        muxAssetIds.push(bondfire.muxAssetId)
      }

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.push(response.muxAssetId)
        }
      }

      expired.push({
        bondfireId: bondfire._id,
        muxAssetIds: [...new Set(muxAssetIds.filter(Boolean))],
      })
    }

    return {
      expired,
      stats,
      continueCursor: candidates.continueCursor,
      isDone: candidates.isDone,
    }
  },
})

// ── Internal Mutation: Delete Convex records for expired bondfires ──

export const deleteExpiredBondfireRecords = internalMutation({
  args: {
    bondfires: v.array(
      v.object({
        bondfireId: v.id('bondfires'),
        muxAssetIds: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let bondfiresDeleted = 0
    let bondfiresSkippedAssetDrift = 0
    let responseVideosDeleted = 0
    const deletedBondfiresByUser = new Map<Id<'users'>, number>()
    const deletedResponsesByUser = new Map<Id<'users'>, number>()
    const deletedBondfiresByCamp = new Map<Id<'camps'>, number>()

    for (const { bondfireId, muxAssetIds } of args.bondfires) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) continue

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()

      // Mux deletion has already happened. At this point, only skip if a new
      // asset appeared that this run did not delete; otherwise finishing the
      // Convex cleanup is safer than preserving records that point at deleted assets.
      const expectedMuxAssetIds = new Set(muxAssetIds)
      const currentMuxAssetIds = collectMuxAssetIds([bondfire, ...responses])
      if (!currentMuxAssetIds.every((assetId) => expectedMuxAssetIds.has(assetId))) {
        bondfiresSkippedAssetDrift++
        // Drift means a new asset appeared after we computed the delete set, so
        // we skip to avoid orphaning an undeleted Mux asset. But the expired
        // assets were ALREADY deleted by the action — so this bondfire can be
        // left pointing at deleted assets (an unreachable orphan that violates
        // "expired bondfires are removed entirely"). Log it loudly so we can see
        // whether this race actually happens before reworking the handshake.
        await ctx.db.insert('clientLogs', {
          userId: bondfire.userId,
          level: 'warn',
          event: 'bondfire:failed:retention_asset_drift',
          message: `Retention skipped ${bondfireId} after Mux asset drift; bondfire may now be orphaned`,
          data: {
            reason: 'retention_asset_drift',
            bondfireId,
            videoStatus: bondfire.videoStatus,
            expectedMuxAssetIds: [...expectedMuxAssetIds],
            currentMuxAssetIds,
            createdAt: bondfire.createdAt,
            ageMs: Date.now() - bondfire.createdAt,
          },
          platform: 'server',
          retention: 'forensic',
          createdAt: Date.now(),
        })
        continue
      }

      if (isPlayableVideoRecord(bondfire)) {
        deletedBondfiresByUser.set(
          bondfire.userId,
          (deletedBondfiresByUser.get(bondfire.userId) ?? 0) + 1,
        )
        if (bondfire.campId) {
          deletedBondfiresByCamp.set(
            bondfire.campId,
            (deletedBondfiresByCamp.get(bondfire.campId) ?? 0) + 1,
          )
        }
      }

      for (const response of responses) {
        if (isPlayableVideoRecord(response)) {
          deletedResponsesByUser.set(
            response.userId,
            (deletedResponsesByUser.get(response.userId) ?? 0) + 1,
          )
        }
        await deleteWatchEventsForVideo(ctx, response._id)

        const responseReports = await ctx.db
          .query('reports')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', response._id))
          .collect()
        for (const report of responseReports) {
          await ctx.db.delete(report._id)
        }

        if (response.liveSessionId) {
          await deleteLiveSessionIfExists(ctx, response.liveSessionId)
        }
        await ctx.db.delete(response._id)
        responseVideosDeleted++
      }

      if (bondfire.personalCampId) {
        const participants = await ctx.db
          .query('personalBondfireParticipants')
          .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId))
          .collect()
        for (const participant of participants) {
          await ctx.db.delete(participant._id)
        }
      }

      const threadReads = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      for (const read of threadReads) {
        await ctx.db.delete(read._id)
      }

      await deleteBondfireInviteArtifacts(ctx, bondfireId)

      await deleteWatchEventsForVideo(ctx, bondfireId)

      const reports = await ctx.db
        .query('reports')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      for (const report of reports) {
        await ctx.db.delete(report._id)
      }

      if (bondfire.liveSessionId) {
        await deleteLiveSessionIfExists(ctx, bondfire.liveSessionId)
      }

      await ctx.db.delete(bondfireId)
      bondfiresDeleted++
    }

    const affectedUserIds = new Set([
      ...deletedBondfiresByUser.keys(),
      ...deletedResponsesByUser.keys(),
    ])
    for (const userId of affectedUserIds) {
      const user = await ctx.db.get(userId)
      if (!user) continue

      await ctx.db.patch(userId, {
        bondfireCount: Math.max(
          0,
          (user.bondfireCount ?? 0) - (deletedBondfiresByUser.get(userId) ?? 0),
        ),
        responseCount: Math.max(
          0,
          (user.responseCount ?? 0) - (deletedResponsesByUser.get(userId) ?? 0),
        ),
        updatedAt: Date.now(),
      })
    }

    for (const [campId, deletedCount] of deletedBondfiresByCamp) {
      const camp = await ctx.db.get(campId)
      if (!camp) continue

      await ctx.db.patch(campId, {
        bondfireCount: Math.max(0, (camp.bondfireCount ?? 0) - deletedCount),
        updatedAt: Date.now(),
      })
    }

    return { bondfiresDeleted, bondfiresSkippedAssetDrift, responseVideosDeleted }
  },
})

const retentionResultValidator = v.object({
  bondfiresChecked: v.number(),
  bondfiresSkippedLive: v.number(),
  bondfiresSkippedUnlimitedRetention: v.number(),
  bondfiresSkippedNotExpired: v.number(),
  bondfiresSkippedOversized: v.number(),
  bondfiresDeleted: v.number(),
  bondfiresSkippedAssetDrift: v.number(),
  responseVideosDeleted: v.number(),
  muxAssetsDeleted: v.number(),
  muxAssetsMissing: v.number(),
  muxAssetsFailed: v.number(),
})

export const startRetentionSweep = internalMutation({
  args: { runId: v.string(), sweepStartedAt: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', RETENTION_SWEEP_JOB))
      .unique()
    if (existing && !canStartMaintenanceRun(existing, now, RETENTION_SWEEP_LEASE_MS)) {
      return { started: false, activeRunId: existing.runId }
    }
    const run = {
      job: RETENTION_SWEEP_JOB,
      runId: args.runId,
      status: 'running' as const,
      cursor: undefined,
      startedAt: args.sweepStartedAt,
      updatedAt: now,
      completedAt: undefined,
      error: undefined,
      pagesProcessed: 0,
      stats: EMPTY_RETENTION_RESULT,
    }
    if (existing) await ctx.db.replace(existing._id, run)
    else await ctx.db.insert('maintenanceJobRuns', run)
    await ctx.scheduler.runAfter(0, internal.bondfireRetention.runRetentionPage, {
      runId: args.runId,
      sweepStartedAt: args.sweepStartedAt,
    })
    return { started: true, activeRunId: args.runId }
  },
})

export const checkpointRetentionSweep = internalMutation({
  args: {
    runId: v.string(),
    sweepStartedAt: v.number(),
    processedCursor: v.optional(v.string()),
    nextCursor: v.string(),
    isDone: v.boolean(),
    result: retentionResultValidator,
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', RETENTION_SWEEP_JOB))
      .unique()
    if (
      !run ||
      run.runId !== args.runId ||
      run.status !== 'running' ||
      !isExpectedMaintenancePage(run.cursor, args.processedCursor)
    ) {
      return { accepted: false }
    }
    const previous = readRetentionResult(run.stats)
    const totals = Object.fromEntries(
      Object.keys(EMPTY_RETENTION_RESULT).map((key) => [
        key,
        previous[key as keyof RetentionResult] + args.result[key as keyof RetentionResult],
      ]),
    ) as RetentionResult
    const now = Date.now()
    await ctx.db.patch(run._id, {
      cursor: args.isDone ? undefined : args.nextCursor,
      status: args.isDone ? 'complete' : 'running',
      completedAt: args.isDone ? now : undefined,
      updatedAt: now,
      pagesProcessed: run.pagesProcessed + 1,
      stats: totals,
    })
    if (args.isDone) {
      await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
        level: totals.muxAssetsFailed > 0 ? 'warn' : 'info',
        event: 'bondfire:retention_sweep',
        message: 'Bondfire retention sweep completed',
        data: { runId: args.runId, pagesProcessed: run.pagesProcessed + 1, ...totals },
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.bondfireRetention.runRetentionPage, {
        runId: args.runId,
        cursor: args.nextCursor,
        sweepStartedAt: args.sweepStartedAt,
      })
    }
    return { accepted: true }
  },
})

export const failRetentionSweep = internalMutation({
  args: { runId: v.string(), processedCursor: v.optional(v.string()), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', RETENTION_SWEEP_JOB))
      .unique()
    if (
      !run ||
      run.runId !== args.runId ||
      run.status !== 'running' ||
      !isExpectedMaintenancePage(run.cursor, args.processedCursor)
    ) {
      return false
    }
    const error = args.error.slice(0, 500)
    await ctx.db.patch(run._id, { status: 'failed', error, updatedAt: Date.now() })
    await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
      level: 'error',
      event: 'bondfire:retention_sweep_failed',
      message: 'Bondfire retention sweep failed',
      data: { runId: args.runId, pagesProcessed: run.pagesProcessed, error },
    })
    return true
  },
})

export const runRetentionPage = internalAction({
  args: {
    runId: v.string(),
    cursor: v.optional(v.string()),
    sweepStartedAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ accepted: boolean }> => {
    try {
      const batch: ExpiredBondfireBatch = await ctx.runQuery(
        internal.bondfireRetention.findExpiredBondfires,
        {
          cutoff: args.sweepStartedAt - BONDFIRE_RETENTION_MS,
          paginationOpts: {
            cursor: args.cursor ?? null,
            numItems: RETENTION_CANDIDATE_BATCH_SIZE,
          },
        },
      )

      const allMuxAssetIds = [...new Set(batch.expired.flatMap((bondfire) => bondfire.muxAssetIds))]
      const deletableMuxAssetIds = new Set<string>()
      let muxAssetsDeleted = 0
      let muxAssetsMissing = 0
      let muxAssetsFailed = 0
      for (const assetId of allMuxAssetIds) {
        try {
          const result = await deleteMuxAsset(assetId)
          deletableMuxAssetIds.add(assetId)
          if (result === 'missing') muxAssetsMissing++
          else muxAssetsDeleted++
        } catch (error) {
          muxAssetsFailed++
          console.error(`[bondfireRetention] Failed to delete Mux asset ${assetId}:`, error)
        }
      }

      const safeToDelete = batch.expired.filter((bondfire) =>
        bondfire.muxAssetIds.every((id) => deletableMuxAssetIds.has(id)),
      )
      const deleted =
        safeToDelete.length > 0
          ? await ctx.runMutation(internal.bondfireRetention.deleteExpiredBondfireRecords, {
              bondfires: safeToDelete,
            })
          : { bondfiresDeleted: 0, bondfiresSkippedAssetDrift: 0, responseVideosDeleted: 0 }
      const result: RetentionResult = {
        ...batch.stats,
        ...deleted,
        muxAssetsDeleted,
        muxAssetsMissing,
        muxAssetsFailed,
      }
      return await ctx.runMutation(internal.bondfireRetention.checkpointRetentionSweep, {
        runId: args.runId,
        sweepStartedAt: args.sweepStartedAt,
        processedCursor: args.cursor,
        nextCursor: batch.continueCursor,
        isDone: batch.isDone,
        result,
      })
    } catch (error) {
      await ctx.runMutation(internal.bondfireRetention.failRetentionSweep, {
        runId: args.runId,
        processedCursor: args.cursor,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
})

/** Daily entry point. The durable mutation rejects overlapping active runs. */
export const enforceBondfireRetention = internalAction({
  args: {},
  handler: async (ctx): Promise<{ started: boolean; activeRunId: string }> => {
    const sweepStartedAt = Date.now()
    const runId = `${sweepStartedAt}-${Math.random().toString(36).slice(2, 10)}`
    return (await ctx.runMutation(internal.bondfireRetention.startRetentionSweep, {
      runId,
      sweepStartedAt,
    })) as { started: boolean; activeRunId: string }
  },
})
