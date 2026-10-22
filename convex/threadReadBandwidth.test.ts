/// <reference types="vite/client" />
import type { FunctionReturnType, PaginationOptions } from 'convex/server'
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

  it('pages every response beyond 300 with at most 50 response watch lookups per call', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      for (let sequenceNumber = 2; sequenceNumber <= 304; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.responder,
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: `response-${sequenceNumber}`,
          createdAt: 1000 - sequenceNumber,
        })
      }
    })
    const viewer = t.withIdentity({ subject: ids.owner })
    const watch = vi.spyOn(viewerWatchState, 'isVideoWatchedByViewer')
    let cursor: string | null = null
    const sequences: number[][] = []
    for (let pageNumber = 0; pageNumber < 7; pageNumber++) {
      watch.mockClear()
      const detail: FunctionReturnType<typeof api.bondfires.getWithVideos> = await viewer.query(
        api.bondfires.getWithVideos,
        {
          bondfireId: ids.bondfireId,
          ...(cursor ? { paginationOpts: { cursor, numItems: 50 } } : {}),
        },
      )
      if (!detail) throw new Error('Missing detail')
      sequences.push(detail.videos.map((video) => video.sequenceNumber))
      expect(detail.videos.length).toBe(pageNumber === 6 ? 4 : 50)
      expect(detail.isDone).toBe(pageNumber === 6)
      expect(watch).toHaveBeenCalledTimes(1 + detail.videos.length)
      expect(watch.mock.calls.map(([, , video]) => video._id)).toEqual([
        ids.bondfireId,
        ...detail.videos.map((video) => video._id),
      ])
      expect(
        detail.participants.find((entry) => entry.user._id === ids.responder)?.videoCount,
      ).toBe(detail.videos.length)
      cursor = detail.continueCursor
    }
    expect(sequences[0]).toEqual(Array.from({ length: 50 }, (_, i) => 255 + i))
    expect(sequences[1]).toEqual(Array.from({ length: 50 }, (_, i) => 205 + i))
    expect(sequences.reverse().flat()).toEqual(Array.from({ length: 304 }, (_, i) => i + 1))
  })

  it('bounds source reads before visibility, even with a pinned reactive end cursor', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      for (let sequenceNumber = 2; sequenceNumber <= 120; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.outsider,
          sequenceNumber,
          videoStatus: 'ready',
          moderationStatus: 'removed',
          muxPlaybackId: 'hidden',
          createdAt: sequenceNumber,
        })
      }
    })
    const viewer = t.withIdentity({ subject: ids.owner })
    const watch = vi.spyOn(viewerWatchState, 'isVideoWatchedByViewer')
    // Spy on the real query implementation, not a substitute that assumes the
    // handler's bounds. Verify the source scan options as well as hydration.
    const paginations: PaginationOptions[] = []
    await t.run(async (ctx) => {
      const ordered = ctx.db.query('bondfireVideos').order('desc')
      const prototype: typeof ordered = Object.getPrototypeOf(ordered)
      const original = prototype.paginate
      vi.spyOn(prototype, 'paginate').mockImplementation(function (this: typeof ordered, options) {
        paginations.push(options)
        return original.call(this, options)
      })
    })
    const first = await viewer.query(api.bondfires.getResponsePage, {
      bondfireId: ids.bondfireId,
      paginationOpts: { cursor: null, numItems: 500, maximumRowsRead: 5000 },
    })
    expect(first.page).toEqual([])
    expect(first.isDone).toBe(false)
    expect(watch).toHaveBeenCalledTimes(1) // Spark only; never hydrate the hidden head.
    expect(paginations.at(-1)).toEqual(
      expect.objectContaining({ numItems: 50, maximumRowsRead: 50 }),
    )
    const second = await viewer.query(api.bondfires.getResponsePage, {
      bondfireId: ids.bondfireId,
      paginationOpts: { cursor: first.continueCursor, numItems: 50 },
    })
    const pinned = await viewer.query(api.bondfires.getResponsePage, {
      bondfireId: ids.bondfireId,
      paginationOpts: { cursor: null, endCursor: second.continueCursor, numItems: 500 },
    })
    expect(paginations.at(-1)).toEqual(
      expect.objectContaining({
        endCursor: second.continueCursor,
        numItems: 50,
        maximumRowsRead: 50,
      }),
    )
    expect(pinned.page.length).toBeLessThanOrEqual(50)
    expect(pinned.pageStatus).toBe('SplitRequired')
    expect(pinned.splitCursor).toBeTruthy()
    const last = await viewer.query(api.bondfires.getResponsePage, {
      bondfireId: ids.bondfireId,
      paginationOpts: { cursor: second.continueCursor, numItems: 50 },
    })
    expect(last.isDone).toBe(true)
    expect(last.page.map((row) => row.video._id)).toEqual([ids.responseId])
  })

  it('does not read responses or their watch state for the metadata subscription', async () => {
    const { t, ids } = await fixture()
    const watch = vi.spyOn(viewerWatchState, 'isVideoWatchedByViewer')
    const paginations: PaginationOptions[] = []
    await t.run(async (ctx) => {
      const ordered = ctx.db.query('bondfireVideos').order('desc')
      const prototype: typeof ordered = Object.getPrototypeOf(ordered)
      const original = prototype.paginate
      vi.spyOn(prototype, 'paginate').mockImplementation(function (this: typeof ordered, options) {
        paginations.push(options)
        return original.call(this, options)
      })
    })
    const detail = await t.withIdentity({ subject: ids.owner }).query(api.bondfires.getWithVideos, {
      bondfireId: ids.bondfireId,
      metadataOnly: true,
    })
    expect(detail?.videos).toEqual([])
    expect(detail?.participants.map((entry) => entry.user._id)).toEqual([ids.owner])
    expect(watch.mock.calls.map(([, , video]) => video._id)).toEqual([ids.bondfireId])
    expect(paginations).toEqual([])
  })

  it('keeps processing projections and late replies reachable without exposing private media fields', async () => {
    const { t, ids } = await fixture()
    const processingId = await t.run(async (ctx) => {
      for (let sequenceNumber = 2; sequenceNumber <= 301; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.responder,
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: `response-${sequenceNumber}`,
          createdAt: sequenceNumber,
        })
      }
      return ctx.db.insert('bondfireVideos', {
        bondfireId: ids.bondfireId,
        userId: ids.outsider,
        sequenceNumber: 302,
        videoStatus: 'processing',
        muxAssetId: 'private',
        createdAt: 302,
      })
    })
    const result = await t
      .withIdentity({ subject: ids.owner })
      .query(api.bondfires.getWithVideos, { bondfireId: ids.bondfireId })
    expect(result?.videos.at(-1)?.sequenceNumber).toBe(301)
    expect(result?.processingResponses).toEqual([
      {
        _id: processingId,
        userId: ids.outsider,
        createdAt: 302,
        sequenceNumber: 302,
      },
    ])
    expect(result?.participants.map((entry) => entry.user._id)).not.toContain(ids.outsider)
  })

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

  it('marks an older-page participant read and safely skips observers', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      for (let sequenceNumber = 2; sequenceNumber <= 60; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: ids.owner,
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: 'newer',
          createdAt: sequenceNumber,
        })
      }
    })
    const responder = t.withIdentity({ subject: ids.responder })
    const detail = await responder.query(api.bondfires.getWithVideos, {
      bondfireId: ids.bondfireId,
    })
    expect(detail?.participants.map((entry) => entry.user._id)).not.toContain(ids.responder)
    expect(
      await responder.mutation(api.conversations.markThreadRead, {
        bondfireId: ids.bondfireId,
        skipNonParticipant: true,
      }),
    ).toBeTruthy()
    expect(
      await t.withIdentity({ subject: ids.outsider }).mutation(api.conversations.markThreadRead, {
        bondfireId: ids.bondfireId,
        skipNonParticipant: true,
      }),
    ).toBeNull()
  })

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
