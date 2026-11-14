/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { auth } from './auth'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { listMyFiresPage } from './conversations'
import { releaseThreadParticipant, THREAD_MEMBERSHIP_JOB } from './lib/threadMembership'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const profile = {
  birthDate: '1990-01-01',
  gender: 'other' as const,
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
  acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
}

async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert('users', { ...profile, displayName: 'Owner' })
    const responder = await ctx.db.insert('users', { ...profile, displayName: 'Responder' })
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: owner,
      videoStatus: 'ready',
      muxPlaybackId: 'spark',
      videoCount: 1,
      viewCount: 0,
      createdAt: 100,
      updatedAt: 100,
    })
    const responseId = await ctx.db.insert('bondfireVideos', {
      bondfireId,
      userId: responder,
      sequenceNumber: 1,
      videoStatus: 'ready',
      muxPlaybackId: 'response',
      createdAt: 200,
    })
    return { owner, responder, bondfireId, responseId }
  })
  return { t, ids }
}

async function insertFire(
  t: ReturnType<typeof convexTest>,
  userId: Id<'users'>,
  createdAt: number,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('bondfires', {
      userId,
      videoStatus: 'ready',
      muxPlaybackId: `spark-${createdAt}`,
      videoCount: 1,
      viewCount: 0,
      createdAt,
      updatedAt: createdAt,
    })
  })
}

async function markIndexReady(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert('maintenanceJobRuns', {
      job: THREAD_MEMBERSHIP_JOB,
      runId: 'test',
      status: 'complete',
      startedAt: 1,
      updatedAt: 1,
      pagesProcessed: 1,
      stats: {},
    })
  })
}

describe('thread membership index', () => {
  it('keeps the legacy scan until the backfill is complete', async () => {
    const { t, ids } = await fixture()
    const page = await t
      .withIdentity({ subject: ids.owner })
      .query(api.conversations.listMyFiresPage, {
        paginationOpts: { numItems: 20, cursor: null },
      })
    expect(page.page.map((thread) => thread._id)).toEqual([ids.bondfireId])
    expect(page.isDone).toBe(true)
  })

  it('pages memberships by activity and skips fires with no membership', async () => {
    const { t, ids } = await fixture()
    const older = await insertFire(t, ids.owner, 50)
    const newest = await insertFire(t, ids.owner, 300)
    await markIndexReady(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadMemberships', {
        userId: ids.owner,
        bondfireId: ids.bondfireId,
        lastActivityAt: 100,
      })
      await ctx.db.insert('threadMemberships', {
        userId: ids.owner,
        bondfireId: newest,
        lastActivityAt: 300,
      })
    })
    const viewer = t.withIdentity({ subject: ids.owner })
    const first = await viewer.query(api.conversations.listMyFiresPage, {
      paginationOpts: { numItems: 1, cursor: null },
    })
    expect(first.page.map((thread) => thread._id)).toEqual([newest])
    expect(first.isDone).toBe(false)
    const second = await viewer.query(api.conversations.listMyFiresPage, {
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    })
    expect(second.page.map((thread) => thread._id)).toEqual([ids.bondfireId])
    expect(second.page.map((thread) => thread._id)).not.toContain(older)

    const capped = await viewer.query(api.conversations.listMyFires, {})
    expect(capped.map((thread) => thread._id)).toEqual([newest, ids.bondfireId])
  })

  it('does not scan bondfires once the membership index is ready', async () => {
    const { t, ids } = await fixture()
    await markIndexReady(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('threadMemberships', {
        userId: ids.owner,
        bondfireId: ids.bondfireId,
        lastActivityAt: 100,
      })
      vi.spyOn(auth, 'getUserId').mockResolvedValue(ids.owner)
      const query = vi.spyOn(ctx.db, 'query')
      const handler = (
        listMyFiresPage as unknown as {
          _handler: (
            ctx: QueryCtx,
            args: { paginationOpts: { numItems: number; cursor: null } },
          ) => Promise<{ page: Array<{ _id: Id<'bondfires'> }> }>
        }
      )._handler
      const page = await handler(ctx, { paginationOpts: { numItems: 20, cursor: null } })
      expect(page.page.map((thread) => thread._id)).toEqual([ids.bondfireId])
      expect(query.mock.calls.filter(([table]) => table === 'bondfires')).toHaveLength(0)
    })
  })

  it('puts a pinned fire on the first page even when its activity is older', async () => {
    const { t, ids } = await fixture()
    const newest = await insertFire(t, ids.owner, 300)
    await markIndexReady(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.owner, { pinnedBondfireIds: [ids.bondfireId] })
      for (const [bondfireId, lastActivityAt] of [
        [ids.bondfireId, 100],
        [newest, 300],
      ] as const) {
        await ctx.db.insert('threadMemberships', {
          userId: ids.owner,
          bondfireId,
          lastActivityAt,
        })
      }
    })
    const page = await t
      .withIdentity({ subject: ids.owner })
      .query(api.conversations.listMyFiresPage, {
        pinnedFirst: true,
        paginationOpts: { numItems: 1, cursor: null },
      })
    expect(page.page[0]?._id).toBe(ids.bondfireId)
    expect(page.page.map((thread) => thread._id)).toContain(newest)
  })

  it('drops a responder membership when their last response is deleted', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.insert('threadMemberships', {
        userId: ids.owner,
        bondfireId: ids.bondfireId,
        lastActivityAt: 100,
      })
      await ctx.db.insert('threadMemberships', {
        userId: ids.responder,
        bondfireId: ids.bondfireId,
        lastActivityAt: 200,
      })
      await releaseThreadParticipant(ctx, ids.responder, ids.bondfireId)
      const kept = await ctx.db.query('threadMemberships').collect()
      expect(kept.map((row) => row.userId).sort()).toEqual([ids.owner, ids.responder].sort())

      await ctx.db.delete(ids.responseId)
      await releaseThreadParticipant(ctx, ids.responder, ids.bondfireId)
      const left = await ctx.db.query('threadMemberships').collect()
      expect(left.map((row) => row.userId)).toEqual([ids.owner])
    })
  })
})
