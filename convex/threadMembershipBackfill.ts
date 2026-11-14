import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { THREAD_MEMBERSHIP_JOB, threadMembershipIndexReady } from './lib/threadMembership'
import { isPlayableVideoRecord } from './lib/videoLifecycle'

const RESPONSE_PAGE = 25
const STALE_MS = 60_000

type ScanState = {
  nextBondfireCursor: string | null
  bondfiresDone: boolean
  bondfireId?: Id<'bondfires'>
  responseCursor: string | null
  activity: number
}

function parseState(cursor: string | undefined): ScanState | null {
  if (!cursor) return null
  const parsed = JSON.parse(cursor) as ScanState
  if (!parsed || typeof parsed.activity !== 'number') return null
  return parsed
}

async function openNextBondfire(
  ctx: MutationCtx,
  state: ScanState | null,
): Promise<ScanState | 'done'> {
  const page = await ctx.db
    .query('bondfires')
    .withIndex('by_created')
    .order('asc')
    .paginate({ cursor: state?.nextBondfireCursor ?? null, numItems: 1 })
  const bondfire = page.page[0]
  if (!bondfire) return page.isDone ? 'done' : (state ?? 'done')
  const next: ScanState = {
    nextBondfireCursor: page.continueCursor,
    bondfiresDone: page.isDone,
    responseCursor: null,
    activity: Math.max(bondfire.createdAt, bondfire.threadLastActivityAt ?? 0),
  }
  if (bondfire.status === 'draft') return page.isDone ? 'done' : next
  const existing = await ctx.db
    .query('threadMemberships')
    .withIndex('by_user_bondfire', (q) =>
      q.eq('userId', bondfire.userId).eq('bondfireId', bondfire._id),
    )
    .unique()
  if (!existing) {
    await ctx.db.insert('threadMemberships', {
      userId: bondfire.userId,
      bondfireId: bondfire._id,
      lastActivityAt: next.activity,
    })
  }
  return { ...next, bondfireId: bondfire._id }
}

async function advance(ctx: MutationCtx, state: ScanState | null): Promise<ScanState | 'done'> {
  if (!state?.bondfireId) return await openNextBondfire(ctx, state)
  const bondfireId = state.bondfireId
  const responses = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire_created', (q) => q.eq('bondfireId', bondfireId))
    .order('asc')
    .paginate({ cursor: state.responseCursor, numItems: RESPONSE_PAGE })
  let activity = state.activity
  for (const response of responses.page) {
    const existing = await ctx.db
      .query('threadMemberships')
      .withIndex('by_user_bondfire', (q) =>
        q.eq('userId', response.userId).eq('bondfireId', bondfireId),
      )
      .unique()
    if (!existing) {
      await ctx.db.insert('threadMemberships', {
        userId: response.userId,
        bondfireId,
        lastActivityAt: activity,
      })
    }
    if (isPlayableVideoRecord(response)) activity = Math.max(activity, response.createdAt)
  }
  if (!responses.isDone) {
    return { ...state, responseCursor: responses.continueCursor, activity }
  }
  const bondfire = await ctx.db.get(bondfireId)
  activity = Math.max(activity, bondfire?.threadLastActivityAt ?? 0, bondfire?.createdAt ?? 0)
  if (bondfire && (bondfire.threadLastActivityAt ?? 0) < activity) {
    await ctx.db.patch(bondfire._id, { threadLastActivityAt: activity })
  }
  const members = await ctx.db
    .query('threadMemberships')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .collect()
  for (const member of members) {
    if (member.lastActivityAt < activity)
      await ctx.db.patch(member._id, { lastActivityAt: activity })
  }
  if (state.bondfiresDone) return 'done'
  return {
    nextBondfireCursor: state.nextBondfireCursor,
    bondfiresDone: false,
    responseCursor: null,
    activity: 0,
  }
}

export const status = internalQuery({
  args: {},
  handler: async (ctx) => ({ ready: await threadMembershipIndexReady(ctx) }),
})

export const kick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', THREAD_MEMBERSHIP_JOB))
      .first()
    if (existing?.status === 'complete') return
    if (existing?.status === 'running' && now - existing.updatedAt < STALE_MS) return
    const runId = `${THREAD_MEMBERSHIP_JOB}:${existing?.runId ?? now}`
    const fields = {
      job: THREAD_MEMBERSHIP_JOB,
      runId: existing?.status === 'running' ? existing.runId : runId,
      status: 'running' as const,
      cursor: existing?.cursor,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      completedAt: undefined,
      error: undefined,
      pagesProcessed: existing?.pagesProcessed ?? 0,
      stats: existing?.stats ?? { bondfires: 0 },
    }
    if (existing) await ctx.db.patch(existing._id, fields)
    else await ctx.db.insert('maintenanceJobRuns', fields)
    await ctx.scheduler.runAfter(0, internal.threadMembershipBackfill.scanPage, {
      runId: fields.runId,
    })
  },
})

export const scanPage = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', THREAD_MEMBERSHIP_JOB))
      .first()
    if (!run || run.runId !== args.runId || run.status !== 'running') return
    const next = await advance(ctx, parseState(run.cursor))
    const now = Date.now()
    if (next === 'done') {
      await ctx.db.patch(run._id, {
        status: 'complete',
        cursor: undefined,
        updatedAt: now,
        completedAt: now,
        pagesProcessed: run.pagesProcessed + 1,
      })
      return
    }
    await ctx.db.patch(run._id, {
      cursor: JSON.stringify(next),
      updatedAt: now,
      pagesProcessed: run.pagesProcessed + 1,
      stats: {
        bondfires: (run.stats?.bondfires ?? 0) + (next.bondfireId ? 0 : 1),
      },
    })
    await ctx.scheduler.runAfter(0, internal.threadMembershipBackfill.scanPage, {
      runId: args.runId,
    })
  },
})
