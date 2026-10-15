/// <reference types="vite/client" />
import type { FunctionReturnType } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { auth } from './auth'
import { getWithVideos } from './bondfires'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { isThreadParticipant, listCloseCircle, listMyFires } from './conversations'
import * as viewerWatchState from './lib/viewerWatchState'
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
    const outsider = await ctx.db.insert('users', { ...profile, displayName: 'Outsider' })
    const campId = await ctx.db.insert('camps', {
      slug: 'thread-reads',
      name: 'Thread reads',
      purpose: 'Test',
      access: 'invite',
      status: 'active',
      ageBand: 'adult',
      ownerId: owner,
      rules: { access: {}, participation: { maxDurationMs: 10000 }, advisory: {} },
      createdAt: 100,
      updatedAt: 100,
    })
    for (const userId of [owner, responder]) {
      await ctx.db.insert('campMembers', {
        userId,
        campId,
        role: userId === owner ? 'owner' : 'member',
        status: 'active',
        muted: true,
        createdAt: 100,
        updatedAt: 100,
      })
    }
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: owner,
      campId,
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
    return { owner, responder, outsider, campId, bondfireId, responseId }
  })
  return { t, ids }
}

afterEach(() => vi.restoreAllMocks())

describe('thread read bandwidth', () => {
  it('reads responses once for detail and reuses user documents for participants', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      vi.spyOn(auth, 'getUserId').mockResolvedValue(ids.owner)
      const query = vi.spyOn(ctx.db, 'query')
      const get = vi.spyOn(ctx.db, 'get')
      const handler = (
        getWithVideos as unknown as {
          _handler: (
            ctx: QueryCtx,
            args: { bondfireId: string },
          ) => Promise<FunctionReturnType<typeof api.bondfires.getWithVideos>>
        }
      )._handler
      const detail = await handler(ctx, { bondfireId: ids.bondfireId })
      expect(detail?.videos.map((video) => video._id)).toEqual([ids.responseId])
      expect(detail?.participants.map((entry) => entry.user._id)).toEqual([
        ids.responder,
        ids.owner,
      ])
      expect(query.mock.calls.filter(([table]) => table === 'bondfireVideos')).toHaveLength(1)
      expect(get.mock.calls.filter(([id]) => id === ids.responder)).toHaveLength(1)
      expect(get.mock.calls.filter(([id]) => id === ids.campId)).toHaveLength(1)
      expect(detail?.campName).toBe('Thread reads')
    })
  })

  it('keeps detail reads constant as a thread grows beyond the 300-response window', async () => {
    const { t, ids } = await fixture()
    const processingId = await t.run(async (ctx) => {
      await ctx.db.patch(ids.responseId, { durationMs: 10000 })
      await ctx.db.insert('watchEvents', {
        userId: ids.owner,
        videoType: 'response',
        videoId: ids.responseId,
        eventType: 'complete',
        positionMs: 10000,
        createdAt: 300,
      })
      await ctx.db.insert('closeCirclePins', {
        ownerId: ids.owner,
        pinnedUserId: ids.responder,
        order: 0,
        createdAt: 300,
        updatedAt: 300,
      })
      for (let sequenceNumber = 2; sequenceNumber <= 299; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.responder,
          sequenceNumber,
          videoStatus: 'ready',
          moderationStatus: sequenceNumber === 299 ? 'removed' : undefined,
          muxPlaybackId: `response-${sequenceNumber}`,
          durationMs: 10000,
          // Creation order deliberately disagrees with playback sequence.
          createdAt: 1000 - sequenceNumber,
        })
      }
      return ctx.db.insert('bondfireVideos', {
        bondfireId: ids.bondfireId,
        userId: ids.responder,
        creatorName: 'Responder',
        sequenceNumber: 300,
        videoStatus: 'processing',
        muxAssetId: 'private-processing-asset',
        createdAt: 1000,
      })
    })
    const watch = vi.spyOn(viewerWatchState, 'isVideoWatchedByViewer')
    const readDetail = () =>
      t.withIdentity({ subject: ids.owner }).query(async (ctx) => {
        const detail = await ctx.runQuery(
          api.bondfires.getWithVideos,
          { bondfireId: ids.bondfireId },
          {
            transactionLimits: { documentsRead: 350, bytesRead: 200000 },
          },
        )
        return { detail, metrics: await ctx.meta.getTransactionMetrics() }
      })
    const before = await readDetail()
    expect(before.detail?.videos.map((video) => video.sequenceNumber)).toEqual(
      Array.from({ length: 298 }, (_, i) => i + 1),
    )
    expect(before.detail?.watchedByViewer).toBe(true)
    expect(before.detail?.videos[0]?.watchedByViewer).toBe(true)
    expect(before.detail?.videos.slice(1).every((video) => !video.watchedByViewer)).toBe(true)
    expect(before.detail?.processingResponses).toEqual([
      {
        _id: processingId,
        userId: ids.responder,
        creatorName: 'Responder',
        createdAt: 1000,
      },
    ])
    expect(before.detail?.participants).toMatchObject([
      { user: { _id: ids.responder }, videoCount: 298, latestAt: 998, isPinned: true },
      { user: { _id: ids.owner }, videoCount: 1, latestAt: 100, isPinned: false },
    ])
    expect(watch).toHaveBeenCalledTimes(299) // Spark + displayed playable responses only.
    watch.mockClear()
    await t.run(async (ctx) => {
      for (let sequenceNumber = 301; sequenceNumber <= 1500; sequenceNumber++) {
        const videoId = await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.outsider,
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: `overflow-${sequenceNumber}`,
          summary: 'x'.repeat(1000),
          createdAt: sequenceNumber,
        })
        await ctx.db.insert('watchEvents', {
          userId: ids.owner,
          videoType: 'response',
          videoId,
          eventType: 'complete',
          positionMs: 10000,
          createdAt: 2000,
        })
      }
    })
    const after = await readDetail()
    expect(after.detail).toEqual(before.detail)
    expect(after.metrics.documentsRead.used).toBe(before.metrics.documentsRead.used)
    expect(after.metrics.bytesRead.used).toBe(before.metrics.bytesRead.used)
    expect(after.metrics.documentsRead.used).toBeGreaterThanOrEqual(300)
    const unbounded = await t.query(async (ctx) => {
      // Compare with the old response scan alone, excluding its extra author
      // and watch reads. The cap saves at least 75% of bytes in this fixture.
      await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', ids.bondfireId))
        .collect()
      return ctx.meta.getTransactionMetrics()
    })
    expect(after.metrics.bytesRead.used).toBeLessThan(unbounded.bytesRead.used / 4)
    expect(watch).toHaveBeenCalledTimes(299)
    expect(watch.mock.calls.map(([, , video]) => video._id)).toEqual([
      ids.bondfireId,
      ...(after.detail?.videos.map((video) => video._id) ?? []),
    ])
  }, 15000)

  it('reuses participant users across list summaries and first-unwatched resolution', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const bondfireId = await ctx.db.insert('bondfires', {
        userId: ids.owner,
        campId: ids.campId,
        videoStatus: 'ready',
        muxPlaybackId: 'second-spark',
        videoCount: 1,
        viewCount: 0,
        createdAt: 300,
        updatedAt: 300,
      })
      await ctx.db.insert('bondfireVideos', {
        bondfireId,
        userId: ids.responder,
        sequenceNumber: 1,
        videoStatus: 'ready',
        muxPlaybackId: 'second-response',
        createdAt: 400,
      })
    })
    await t.run(async (ctx) => {
      vi.spyOn(auth, 'getUserId').mockResolvedValue(ids.owner)
      const get = vi.spyOn(ctx.db, 'get')
      const handler = (
        listMyFires as unknown as {
          _handler: (
            ctx: QueryCtx,
            args: Record<string, never>,
          ) => Promise<FunctionReturnType<typeof api.conversations.listMyFires>>
        }
      )._handler
      const threads = await handler(ctx, {})
      expect(threads.map((thread) => thread.firstUnwatchedResponder?._id)).toEqual([
        ids.responder,
        ids.responder,
      ])
      expect(get.mock.calls.filter(([id]) => id === ids.responder)).toHaveLength(1)
      expect(get.mock.calls.filter(([id]) => id === ids.campId)).toHaveLength(1)
    })
  })

  it('shares cached users and camps across concurrent Close Circle summaries', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.insert('closeCirclePins', {
        ownerId: ids.responder,
        pinnedUserId: ids.owner,
        order: 0,
        createdAt: 300,
        updatedAt: 300,
      })
      vi.spyOn(auth, 'getUserId').mockResolvedValue(ids.responder)
      const get = vi.spyOn(ctx.db, 'get')
      const handler = (
        listCloseCircle as unknown as {
          _handler: (
            ctx: QueryCtx,
            args: Record<string, never>,
          ) => Promise<FunctionReturnType<typeof api.conversations.listCloseCircle>>
        }
      )._handler
      const entries = await handler(ctx, {})
      expect(entries).toHaveLength(1)
      expect(entries[0]?.sharedThreads.map((thread) => thread._id)).toEqual([ids.bondfireId])
      expect(entries[0]?.privateCampThreads.map((thread) => thread._id)).toEqual([ids.bondfireId])
      expect(get.mock.calls.filter(([id]) => id === ids.owner)).toHaveLength(1)
      expect(get.mock.calls.filter(([id]) => id === ids.campId)).toHaveLength(1)
    })
  })

  it.each([
    { moderationStatus: 'removed' },
    { moderationStatus: 'pending_review' },
    { videoStatus: 'pending' },
    { videoStatus: 'errored' },
    { videoStatus: 'awaiting_recovery' },
    { expiresAt: 1 },
  ] satisfies Partial<Doc<'bondfireVideos'>>[])(
    'skips author and block lookups for excluded responses %j',
    async (patch) => {
      const { t, ids } = await fixture()
      await t.run(async (ctx) => {
        await ctx.db.patch(ids.responseId, patch)
        vi.spyOn(auth, 'getUserId').mockResolvedValue(ids.owner)
        const get = vi.spyOn(ctx.db, 'get')
        const query = vi.spyOn(ctx.db, 'query')
        const detailHandler = (
          getWithVideos as unknown as {
            _handler: (
              ctx: QueryCtx,
              args: { bondfireId: string },
            ) => Promise<FunctionReturnType<typeof api.bondfires.getWithVideos>>
          }
        )._handler
        const detail = await detailHandler(ctx, { bondfireId: ids.bondfireId })
        expect(detail?.videos).toEqual([])
        expect(detail?.processingResponses).toEqual([])
        expect(detail?.participants.map((entry) => entry.user._id)).toEqual([ids.owner])

        const listHandler = (
          listMyFires as unknown as {
            _handler: (
              ctx: QueryCtx,
              args: Record<string, never>,
            ) => Promise<FunctionReturnType<typeof api.conversations.listMyFires>>
          }
        )._handler
        const threads = await listHandler(ctx, {})
        expect(threads[0]?.participants.map((entry) => entry.user._id)).toEqual([ids.owner])
        expect(get.mock.calls.filter(([id]) => id === ids.responder)).toHaveLength(0)
        expect(query.mock.calls.filter(([table]) => table === 'userBlocks')).toHaveLength(0)
      })
    },
  )

  it('does not query responses for the thread owner', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const bondfire = await ctx.db.get(ids.bondfireId)
      if (!bondfire) throw new Error('Missing fixture')
      const query = vi.spyOn(ctx.db, 'query')
      expect(await isThreadParticipant(ctx, bondfire, ids.owner)).toBe(true)
      expect(query).not.toHaveBeenCalled()
    })
  })

  it('uses both index keys and stops reading after the first qualifying response', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const bondfire = await ctx.db.get(ids.bondfireId)
      const response = await ctx.db.get(ids.responseId)
      if (!bondfire || !response) throw new Error('Missing fixture')
      const readRow = vi.fn()
      const eq = vi.fn().mockReturnThis()
      const withIndex = vi.fn((_name, range) => {
        range({ eq })
        return {
          async *[Symbol.asyncIterator]() {
            readRow()
            yield response
            readRow()
            throw new Error('Read past membership match')
          },
        }
      })
      const query = vi.fn(() => ({ withIndex }))
      const instrumented = { ...ctx, db: { ...ctx.db, query } } as unknown as QueryCtx
      expect(await isThreadParticipant(instrumented, bondfire, ids.responder)).toBe(true)
      expect(query).toHaveBeenCalledWith('bondfireVideos')
      expect(withIndex.mock.calls[0]?.[0]).toBe('by_bondfire_user')
      expect(eq.mock.calls).toEqual([
        ['bondfireId', ids.bondfireId],
        ['userId', ids.responder],
      ])
      expect(readRow).toHaveBeenCalledTimes(1)
    })
  })
})

describe('thread participant semantics', () => {
  it.each([
    { moderationStatus: 'removed' },
    { moderationStatus: 'pending_review' },
    { videoStatus: 'pending' },
    { videoStatus: 'processing' },
    { videoStatus: 'errored' },
    { expiresAt: 1 },
    { muxPlaybackId: undefined },
  ] satisfies Partial<Doc<'bondfireVideos'>>[])(
    'rejects nonparticipating response %j',
    async (patch) => {
      const { t, ids } = await fixture()
      await t.run(async (ctx) => ctx.db.patch(ids.responseId, patch))
      await expect(
        t.withIdentity({ subject: ids.responder }).mutation(api.conversations.markThreadRead, {
          bondfireId: ids.bondfireId,
        }),
      ).rejects.toThrow('Only thread participants')
    },
  )

  it.each([
    { videoStatus: undefined },
    { videoStatus: 'live', muxPlaybackId: undefined, muxLivePlaybackId: 'live' },
  ] satisfies Partial<Doc<'bondfireVideos'>>[])(
    'accepts legacy and live playback %j',
    async (patch) => {
      const { t, ids } = await fixture()
      await t.run(async (ctx) => ctx.db.patch(ids.responseId, patch))
      const markerId = await t
        .withIdentity({ subject: ids.responder })
        .mutation(api.conversations.markThreadRead, { bondfireId: ids.bondfireId })
      expect(markerId).toBeTruthy()
    },
  )

  it('accepts private segmented playback without a Mux ID', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const recordingId = await ctx.db.insert('segmentRecordings', {
        userId: ids.responder,
        localId: 'segmented',
        responseId: ids.responseId,
        status: 'ready',
        segmentCount: 1,
        duration: 4,
        maxDuration: 60,
        createdAt: 100,
        updatedAt: 100,
      })
      await ctx.db.patch(ids.responseId, {
        muxPlaybackId: undefined,
        segmentRecordingId: recordingId,
      })
    })
    expect(
      await t.withIdentity({ subject: ids.responder }).mutation(api.conversations.markThreadRead, {
        bondfireId: ids.bondfireId,
      }),
    ).toBeTruthy()
  })

  it('rejects another thread responder and accepts a match beyond many failed uploads', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const response = await ctx.db.get(ids.responseId)
      if (!response) throw new Error('Missing fixture')
      await ctx.db.patch(ids.responseId, { videoStatus: 'processing' })
      for (let i = 2; i <= 252; i++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.responder,
          sequenceNumber: i,
          videoStatus: i === 252 ? 'ready' : 'errored',
          muxPlaybackId: 'playback',
          createdAt: i * 100,
        })
      }
      const otherThread = await ctx.db.insert('bondfires', {
        userId: ids.owner,
        videoCount: 1,
        viewCount: 0,
        createdAt: 100,
        updatedAt: 100,
      })
      await ctx.db.insert('bondfireVideos', {
        bondfireId: otherThread,
        userId: ids.outsider,
        sequenceNumber: 1,
        muxPlaybackId: 'other',
        createdAt: 200,
      })
    })
    await expect(
      t.withIdentity({ subject: ids.outsider }).mutation(api.conversations.markThreadRead, {
        bondfireId: ids.bondfireId,
      }),
    ).rejects.toThrow('Only thread participants')
    expect(
      await t.withIdentity({ subject: ids.responder }).mutation(api.conversations.markThreadRead, {
        bondfireId: ids.bondfireId,
      }),
    ).toBeTruthy()
  })

  it.each(['removed', 'pending_review', 'blocked', 'suspended', 'processing'] as const)(
    'keeps %s response authors out of detail participants',
    async (state) => {
      const { t, ids } = await fixture()
      await t.run(async (ctx) => {
        if (state === 'blocked') {
          await ctx.db.insert('userBlocks', {
            blockerId: ids.responder,
            blockedUserId: ids.owner,
            createdAt: 300,
          })
        } else if (state === 'suspended') {
          await ctx.db.patch(ids.responder, { moderationStatus: 'suspended' })
        } else if (state === 'processing') {
          await ctx.db.patch(ids.responseId, { videoStatus: 'processing' })
        } else {
          await ctx.db.patch(ids.responseId, { moderationStatus: state })
        }
      })
      const detail = await t
        .withIdentity({ subject: ids.owner })
        .query(api.bondfires.getWithVideos, { bondfireId: ids.bondfireId })
      expect(detail?.participants.map((entry) => entry.user._id)).toEqual([ids.owner])
      expect(detail?.videos).toEqual([])
      expect(detail?.processingResponses).toHaveLength(state === 'processing' ? 1 : 0)
    },
  )

  it('includes pending review authors for themselves and admins', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.responseId, { moderationStatus: 'pending_review' })
      await ctx.db.patch(ids.owner, { isAdmin: true })
    })
    for (const viewer of [ids.responder, ids.owner]) {
      const detail = await t
        .withIdentity({ subject: viewer })
        .query(api.bondfires.getWithVideos, { bondfireId: ids.bondfireId })
      expect(detail?.participants.map((entry) => entry.user._id)).toContain(ids.responder)
    }
  })
})
