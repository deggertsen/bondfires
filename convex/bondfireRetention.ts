/**
 * Retention is a database-first, irreversible claim followed by durable cleanup.
 * Eligibility and parent removal share one serializable mutation; there is no
 * query -> external deletion -> recheck gap. Scans checkpoint every bounded page.
 */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { activeTierFromSubscriptions, BONDFIRE_RETENTION_MS, TIER_RANK } from './entitlements'
import { claimBondfire, claimCamp, RETENTION_BATCH_SIZE } from './retentionCleanup'

export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const BUSY_STATUSES = [
  'pending',
  'waiting_for_upload',
  'processing',
  'live',
  'awaiting_recovery',
] as const
type SweepKind = 'bondfire' | 'camp'

export async function canExpireBondfire(
  ctx: MutationCtx | QueryCtx,
  bondfire: Doc<'bondfires'>,
  now: number,
) {
  const cutoff = now - BONDFIRE_RETENTION_MS
  if (
    bondfire.createdAt >= cutoff ||
    BUSY_STATUSES.some((status) => status === bondfire.videoStatus)
  )
    return false
  const live = bondfire.liveSessionId ? await ctx.db.get(bondfire.liveSessionId) : null
  if (live && live.status !== 'ended' && live.status !== 'errored') return false

  // Entitlement reads must also be bounded. Fail closed for an anomalously
  // large subscription history instead of truncating away a paid entitlement.
  const subscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', bondfire.userId))
    .take(101)
  if (subscriptions.length > 100) return false
  const owner = await ctx.db.get(bondfire.userId)
  const tier = owner?.forcedTier ?? activeTierFromSubscriptions(subscriptions, now)
  if (TIER_RANK[tier] >= TIER_RANK.premium) return false

  const newest = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire_created', (q) => q.eq('bondfireId', bondfire._id))
    .order('desc')
    .first()
  if (newest && newest.createdAt >= cutoff) return false
  for (const status of BUSY_STATUSES) {
    const busy = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire_video_status', (q) =>
        q.eq('bondfireId', bondfire._id).eq('videoStatus', status),
      )
      .first()
    if (busy) return false
  }
  return true
}

export function canExpireCamp(camp: Doc<'camps'>, now: number) {
  return (
    camp.status === 'archived' &&
    camp.isLaunchCamp !== true &&
    camp.archivedAt !== undefined &&
    camp.archivedAt <= now - ARCHIVE_RETENTION_MS
  )
}

/** Read-only rollout check; walk every page, including pages with no candidates. */
export const previewPage = internalQuery({
  args: { kind: v.union(v.literal('bondfire'), v.literal('camp')), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now()
    const options = {
      cursor: args.cursor ?? null,
      numItems: RETENTION_BATCH_SIZE,
      maximumBytesRead: 1_000_000,
    }
    const eligibleIds: string[] = []
    if (args.kind === 'bondfire') {
      const page = await ctx.db
        .query('bondfires')
        .withIndex('by_created', (q) => q.lt('createdAt', now - BONDFIRE_RETENTION_MS))
        .paginate(options)
      for (const root of page.page)
        if (await canExpireBondfire(ctx, root, now)) eligibleIds.push(root._id)
      return {
        eligibleIds,
        scanned: page.page.length,
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      }
    }
    const page = await ctx.db
      .query('camps')
      .withIndex('by_status_archived', (q) =>
        q.eq('status', 'archived').lte('archivedAt', now - ARCHIVE_RETENTION_MS),
      )
      .paginate(options)
    for (const camp of page.page) if (canExpireCamp(camp, now)) eligibleIds.push(camp._id)
    return {
      eligibleIds,
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

export async function startRetentionSweep(ctx: MutationCtx, kind: SweepKind) {
  if (process.env.RETENTION_CLAIMS_ENABLED !== 'true') {
    console.info('[retention] New claims disabled; preview and existing cleanup remain available')
    return
  }
  const job = `retention-${kind}`
  const existing = await ctx.db
    .query('maintenanceJobRuns')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first()
  if (existing?.status === 'running') {
    await ctx.scheduler.runAfter(0, internal.bondfireRetention.scanPage, {
      kind,
      runId: existing.runId,
      cursor: existing.cursor,
    })
    return
  }
  const now = Date.now()
  const runId = `${job}:${now}`
  const fields = {
    job,
    runId,
    status: 'running' as const,
    cursor: undefined,
    startedAt: now,
    updatedAt: now,
    completedAt: undefined,
    error: undefined,
    pagesProcessed: 0,
    stats: { scanned: 0, claimed: 0 },
  }
  if (existing) await ctx.db.patch(existing._id, fields)
  else await ctx.db.insert('maintenanceJobRuns', fields)
  await ctx.scheduler.runAfter(0, internal.bondfireRetention.scanPage, { kind, runId })
}

export const scanPage = internalMutation({
  args: {
    kind: v.union(v.literal('bondfire'), v.literal('camp')),
    runId: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (process.env.RETENTION_CLAIMS_ENABLED !== 'true') return
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', `retention-${args.kind}`))
      .first()
    if (!run || run.runId !== args.runId || run.status !== 'running' || run.cursor !== args.cursor)
      return
    // Fix the scan horizon for this run. Eligibility is still rechecked now,
    // in the same transaction that makes deletion visible to other writers.
    const options = {
      cursor: run.cursor ?? null,
      numItems: RETENTION_BATCH_SIZE,
      maximumBytesRead: 1_000_000,
    }
    let claimed = 0
    let page: { page: unknown[]; isDone: boolean; continueCursor: string }
    if (args.kind === 'bondfire') {
      const roots = await ctx.db
        .query('bondfires')
        .withIndex('by_created', (q) => q.lt('createdAt', run.startedAt - BONDFIRE_RETENTION_MS))
        .paginate(options)
      for (const root of roots.page) {
        if (await canExpireBondfire(ctx, root, Date.now())) {
          await claimBondfire(ctx, root)
          claimed++
        }
      }
      page = roots
    } else {
      const camps = await ctx.db
        .query('camps')
        .withIndex('by_status_archived', (q) =>
          q.eq('status', 'archived').lte('archivedAt', run.startedAt - ARCHIVE_RETENTION_MS),
        )
        .paginate(options)
      for (const camp of camps.page) {
        if (canExpireCamp(camp, Date.now())) {
          await claimCamp(ctx, camp)
          claimed++
        }
      }
      page = camps
    }
    await ctx.db.patch(run._id, {
      cursor: page.isDone ? undefined : page.continueCursor,
      status: page.isDone ? 'complete' : 'running',
      updatedAt: Date.now(),
      completedAt: page.isDone ? Date.now() : undefined,
      pagesProcessed: run.pagesProcessed + 1,
      stats: {
        scanned: (run.stats?.scanned ?? 0) + page.page.length,
        claimed: (run.stats?.claimed ?? 0) + claimed,
      },
    })
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.bondfireRetention.scanPage, {
        ...args,
        cursor: page.continueCursor,
      })
    console.info('[retention] Scan page', {
      kind: args.kind,
      scanned: page.page.length,
      claimed,
      done: page.isDone,
    })
  },
})

/** Existing cron entry point; never deletes external media itself. */
export const enforceBondfireRetention = internalMutation({
  args: {},
  handler: async (ctx) => await startRetentionSweep(ctx, 'bondfire'),
})
