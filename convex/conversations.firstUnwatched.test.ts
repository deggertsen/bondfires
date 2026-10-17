/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { buildViewerVisibilityContext } from './bondfireVisibility'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { buildThreadSummary, getFirstUnwatchedResponder } from './conversations'
import * as viewerWatchState from './lib/viewerWatchState'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const profile = {
  birthDate: '1990-01-01',
  gender: 'other' as const,
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
  acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
}

/**
 * A creator sparks a Bondfire, a responder replies, the creator replies back,
 * then a third person replies. sequenceNumber and createdAt both ascend here;
 * individual tests patch createdAt when they need the two to disagree.
 */
async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const creator = await ctx.db.insert('users', { ...profile, displayName: 'Creator' })
    const responder = await ctx.db.insert('users', { ...profile, displayName: 'Responder' })
    const other = await ctx.db.insert('users', { ...profile, displayName: 'Other' })
    const sparkAt = 1_000
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: creator,
      creatorName: 'Creator',
      videoStatus: 'ready',
      muxPlaybackId: 'spark',
      videoCount: 3,
      viewCount: 0,
      createdAt: sparkAt,
      updatedAt: sparkAt,
    })
    const responderVideoId = await ctx.db.insert('bondfireVideos', {
      userId: responder,
      bondfireId,
      creatorName: 'Responder',
      sequenceNumber: 1,
      videoStatus: 'ready',
      muxPlaybackId: 'response-1',
      createdAt: sparkAt + 100,
    })
    const creatorReplyId = await ctx.db.insert('bondfireVideos', {
      userId: creator,
      bondfireId,
      creatorName: 'Creator',
      sequenceNumber: 2,
      videoStatus: 'ready',
      muxPlaybackId: 'response-2',
      createdAt: sparkAt + 200,
    })
    const otherVideoId = await ctx.db.insert('bondfireVideos', {
      userId: other,
      bondfireId,
      creatorName: 'Other',
      sequenceNumber: 3,
      videoStatus: 'ready',
      muxPlaybackId: 'response-3',
      createdAt: sparkAt + 300,
    })
    return { creator, responder, other, bondfireId, responderVideoId, creatorReplyId, otherVideoId }
  })
  return { t, ids }
}

async function markWatched(
  t: ReturnType<typeof convexTest>,
  userId: Id<'users'>,
  videoId: Id<'bondfires'> | Id<'bondfireVideos'>,
  videoType: 'bondfire' | 'response',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('watchEvents', {
      userId,
      videoType,
      videoId,
      eventType: 'complete',
      positionMs: 0,
      createdAt: Date.now(),
    })
  })
}

async function markThreadRead(
  t: ReturnType<typeof convexTest>,
  userId: Id<'users'>,
  bondfireId: Id<'bondfires'>,
  lastReadAt: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('bondfireThreadReads', {
      userId,
      bondfireId,
      lastReadAt,
      createdAt: lastReadAt,
      updatedAt: lastReadAt,
    })
  })
}

async function resolveResponder(
  t: ReturnType<typeof convexTest>,
  bondfireId: Id<'bondfires'>,
  viewerId: Id<'users'>,
) {
  return await t.run(async (ctx) => {
    const bondfire = await ctx.db.get(bondfireId)
    if (!bondfire) throw new Error('Missing fixture bondfire')
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    return await getFirstUnwatchedResponder(ctx, { bondfire, viewerId, viewer })
  })
}

/**
 * The creator of the video the detail screen opens on, computed the way the
 * app does it: getWithVideos order (spark, then responses by sequenceNumber),
 * first entry whose watchedByViewer is false (getInitialVideoIndex).
 */
async function detailScreenOpensOn(
  t: ReturnType<typeof convexTest>,
  bondfireId: Id<'bondfires'>,
  viewerId: Id<'users'>,
) {
  const detail = await t
    .withIdentity({ subject: viewerId })
    .query(api.bondfires.getWithVideos, { bondfireId })
  if (!detail) throw new Error('Detail screen returned null')
  const ordered = [detail, ...detail.videos]
  const opensOn = ordered.find((video) => !video.watchedByViewer)
  return opensOn?.userId ?? null
}

describe('getFirstUnwatchedResponder', () => {
  it('names the creator when the viewer has not watched the spark', async () => {
    const { t, ids } = await fixture()
    const result = await resolveResponder(t, ids.bondfireId, ids.responder)
    expect(result?._id).toBe(ids.creator)
    expect(result?.displayName).toBe('Creator')
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.responder)).toBe(ids.creator)
  })

  it('names the responder of the first unwatched response once the spark is watched', async () => {
    const { t, ids } = await fixture()
    await markWatched(t, ids.other, ids.bondfireId, 'bondfire')
    const result = await resolveResponder(t, ids.bondfireId, ids.other)
    expect(result?._id).toBe(ids.responder)
    expect(result?.displayName).toBe('Responder')
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.other)).toBe(ids.responder)
  })

  it("skips the viewer's own videos and never names the viewer", async () => {
    const { t, ids } = await fixture()
    // The creator is the viewer: the spark and their own reply are implicitly
    // watched, so the first candidate is the responder's video.
    const first = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(first?._id).toBe(ids.responder)

    // Once that is watched, the creator's own reply is skipped and the next
    // unwatched video (from Other) wins.
    await markWatched(t, ids.creator, ids.responderVideoId, 'response')
    const next = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(next?._id).toBe(ids.other)
    expect(next?._id).not.toBe(ids.creator)
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.other)
  })

  it('returns null when every video in the thread is watched', async () => {
    const { t, ids } = await fixture()
    await markWatched(t, ids.creator, ids.responderVideoId, 'response')
    await markWatched(t, ids.creator, ids.otherVideoId, 'response')
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result).toBeNull()
  })

  it('names the older unwatched response even when newer ones are watched', async () => {
    const { t, ids } = await fixture()
    // The creator opened the thread and watched Other's newer reply but never
    // played the responder's older one. The detail screen opens on the older
    // one, so that is the name the row must show.
    await markWatched(t, ids.creator, ids.otherVideoId, 'response')
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result?._id).toBe(ids.responder)
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.responder)
  })

  it('ignores the thread read marker when choosing the video', async () => {
    const { t, ids } = await fixture()
    // Read marker sits after the responder's video. The old scan skipped it;
    // the detail screen never did.
    await markThreadRead(t, ids.creator, ids.bondfireId, 1_250)
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result?._id).toBe(ids.responder)
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.responder)
  })

  it('orders responses by sequenceNumber, not createdAt, when they disagree', async () => {
    const { t, ids } = await fixture()
    // A retried upload lands with a later createdAt but keeps sequence 1.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.responderVideoId, { createdAt: 1_350 })
    })
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result?._id).toBe(ids.responder)
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.responder)
  })

  it('does not read responses when the spark is unwatched', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      const bondfire = await ctx.db.get(ids.bondfireId)
      if (!bondfire) throw new Error('Missing fixture bondfire')
      const viewer = await buildViewerVisibilityContext(ctx, ids.responder)
      const query = vi.spyOn(ctx.db, 'query')
      const result = await getFirstUnwatchedResponder(ctx, {
        bondfire,
        viewerId: ids.responder,
        viewer,
      })
      expect(result?._id).toBe(ids.creator)
      expect(query.mock.calls.some(([table]) => table === 'bondfireVideos')).toBe(false)
      query.mockRestore()
    })
  })

  it.each(['blocked', 'suspended', 'processing', 'pending_review'] as const)(
    'skips %s responses just like the detail screen',
    async (state) => {
      const { t, ids } = await fixture()
      await t.run(async (ctx) => {
        if (state === 'blocked') {
          await ctx.db.insert('userBlocks', {
            blockerId: ids.responder,
            blockedUserId: ids.creator,
            createdAt: 2_000,
          })
        } else if (state === 'suspended') {
          await ctx.db.patch(ids.responder, { moderationStatus: 'suspended' })
        } else if (state === 'processing') {
          await ctx.db.patch(ids.responderVideoId, {
            videoStatus: 'processing',
            muxPlaybackId: undefined,
          })
        } else {
          await ctx.db.patch(ids.responderVideoId, { moderationStatus: state })
        }
      })
      expect((await resolveResponder(t, ids.bondfireId, ids.creator))?._id).toBe(ids.other)
      expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.other)
    },
  )

  it('includes pending-review responses for admins just like the detail screen', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.creator, { isAdmin: true })
      await ctx.db.patch(ids.responderVideoId, { moderationStatus: 'pending_review' })
    })
    expect((await resolveResponder(t, ids.bondfireId, ids.creator))?._id).toBe(ids.responder)
    expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.responder)
  })

  it('skips removed and pending-review responses', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.responderVideoId, { moderationStatus: 'removed' })
      await ctx.db.patch(ids.otherVideoId, { moderationStatus: 'pending_review' })
    })
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result).toBeNull()
  })
})

describe('listMyFires firstUnwatchedResponder', () => {
  it('surfaces the responder on an unread thread the viewer created', async () => {
    const { t, ids } = await fixture()
    const creator = t.withIdentity({ subject: ids.creator })
    const threads = await creator.query(api.conversations.listMyFires, {})
    const thread = threads.find((entry) => entry._id === ids.bondfireId)
    expect(thread?.unread).toBe(true)
    expect(thread?.firstUnwatchedResponder?._id).toBe(ids.responder)
    expect(thread?.firstUnwatchedResponder?._id).not.toBe(ids.creator)
  })

  it('falls back to the latest responder, never the viewer, when nothing is unwatched', async () => {
    const { t, ids } = await fixture()
    // The creator watched every reply but the thread still counts as unread
    // (no read marker, latest activity is not theirs). The row must not print
    // the creator's own name under "New".
    await markWatched(t, ids.creator, ids.responderVideoId, 'response')
    await markWatched(t, ids.creator, ids.otherVideoId, 'response')
    const creator = t.withIdentity({ subject: ids.creator })
    const threads = await creator.query(api.conversations.listMyFires, {})
    const thread = threads.find((entry) => entry._id === ids.bondfireId)
    expect(thread?.unread).toBe(true)
    expect(thread?.firstUnwatchedResponder).not.toBeNull()
    expect(thread?.firstUnwatchedResponder?._id).toBe(ids.other)
    expect(thread?.firstUnwatchedResponder?._id).not.toBe(ids.creator)
  })

  it.each([250, 300])(
    'names the first unwatched responder beyond %s responses instead of the latest participant',
    async (boundary) => {
      const { t, ids } = await fixture()
      await markWatched(t, ids.creator, ids.responderVideoId, 'response')
      await markWatched(t, ids.creator, ids.otherVideoId, 'response')
      await t.run(async (ctx) => {
        for (let sequenceNumber = 4; sequenceNumber <= boundary + 2; sequenceNumber++) {
          const userId =
            sequenceNumber === boundary + 1
              ? ids.responder
              : sequenceNumber === boundary + 2
                ? ids.other
                : ids.creator
          await ctx.db.insert('bondfireVideos', {
            bondfireId: ids.bondfireId,
            userId,
            sequenceNumber,
            videoStatus: 'ready',
            muxPlaybackId: `response-${sequenceNumber}`,
            createdAt: 1_000 + sequenceNumber * 100,
          })
        }
      })
      const threads = await t
        .withIdentity({ subject: ids.creator })
        .query(api.conversations.listMyFires, {})
      const thread = threads.find((entry) => entry._id === ids.bondfireId)
      expect(thread?.unread).toBe(true)
      expect(thread?.firstUnwatchedResponder?._id).toBe(ids.responder)
      expect(await detailScreenOpensOn(t, ids.bondfireId, ids.creator)).toBe(ids.responder)
    },
  )

  it('resolves watch state only after sorting and slicing candidate threads', async () => {
    const { t, ids } = await fixture()
    const newest = await t.run(async (ctx) => {
      const bondfireId = await ctx.db.insert('bondfires', {
        userId: ids.creator,
        videoStatus: 'ready',
        muxPlaybackId: 'new-spark',
        videoCount: 2,
        viewCount: 0,
        createdAt: 10_000,
        updatedAt: 10_000,
      })
      const responseId = await ctx.db.insert('bondfireVideos', {
        bondfireId,
        userId: ids.other,
        sequenceNumber: 1,
        createdAt: 11_000,
        videoStatus: 'ready',
        muxPlaybackId: 'new-response',
      })
      return { bondfireId, responseId }
    })
    const watch = vi.spyOn(viewerWatchState, 'isVideoWatchedByViewer')
    try {
      const threads = await t
        .withIdentity({ subject: ids.creator })
        .query(api.conversations.listMyFires, { limit: 1 })
      expect(threads.map((t) => t._id)).toEqual([newest.bondfireId])
      expect(threads[0].firstUnwatchedResponder?._id).toBe(ids.other)
      expect(watch.mock.calls.map(([, , video]) => video._id)).toEqual([
        newest.bondfireId,
        newest.responseId,
      ])
    } finally {
      watch.mockRestore()
    }
  })

  it('stays null on read threads', async () => {
    const { t, ids } = await fixture()
    await markThreadRead(t, ids.creator, ids.bondfireId, 2_000)
    const creator = t.withIdentity({ subject: ids.creator })
    const threads = await creator.query(api.conversations.listMyFires, {})
    const thread = threads.find((entry) => entry._id === ids.bondfireId)
    expect(thread?.unread).toBe(false)
    expect(thread?.firstUnwatchedResponder).toBeNull()
  })
})

describe('listCloseCircle firstUnwatchedResponder', () => {
  it('stays null even on unread threads because only listMyFires renders it', async () => {
    const { t, ids } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.insert('closeCirclePins', {
        ownerId: ids.creator,
        pinnedUserId: ids.responder,
        order: 0,
        createdAt: 5_000,
        updatedAt: 5_000,
      })
    })
    const creator = t.withIdentity({ subject: ids.creator })
    const entries = await creator.query(api.conversations.listCloseCircle, {})
    const thread = entries
      .flatMap((entry) => entry.sharedThreads)
      .find((entry) => entry._id === ids.bondfireId)
    expect(thread?.unread).toBe(true)
    expect(thread?.firstUnwatchedResponder).toBeNull()
  })
})

describe('bounded thread summaries', () => {
  async function longThread() {
    const { t, ids } = await fixture()
    const authors = await t.run(async (ctx) => {
      const fourth = await ctx.db.insert('users', { ...profile, displayName: 'Fourth' })
      const fifth = await ctx.db.insert('users', { ...profile, displayName: 'Fifth' })
      const authors = [ids.responder, ids.other, fourth, fifth]
      for (let sequenceNumber = 4; sequenceNumber <= 300; sequenceNumber++) {
        await ctx.db.insert('bondfireVideos', {
          bondfireId: ids.bondfireId,
          userId: authors[sequenceNumber % authors.length],
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: `response-${sequenceNumber}`,
          createdAt: 1_000 + sequenceNumber * 100,
        })
      }
      await ctx.db.patch(ids.bondfireId, { videoCount: 301 })
      return authors
    })
    return { t, ids, authors }
  }

  it.each([
    { playback: 'mux', expectedReads: 41 },
    { playback: 'r2', expectedReads: 250 },
  ] as const)(
    'bounds $playback summary reads to $expectedReads for a 300-response thread',
    async ({ playback, expectedReads }) => {
      const { t, ids, authors } = await longThread()
      await t.run(async (ctx) => {
        const bondfire = await ctx.db.get(ids.bondfireId)
        if (!bondfire) throw new Error('Missing fixture')
        if (playback === 'r2') {
          const responses = await ctx.db
            .query('bondfireVideos')
            .withIndex('by_bondfire', (q) => q.eq('bondfireId', ids.bondfireId))
            .collect()
          for (const response of responses)
            await ctx.db.patch(response._id, {
              muxPlaybackId: undefined,
              segmentRecordingId: await ctx.db.insert('segmentRecordings', {
                userId: response.userId,
                localId: `recording-${response.sequenceNumber}`,
                responseId: response._id,
                status: 'ready',
                segmentCount: 1,
                duration: 10,
                maxDuration: 60,
                createdAt: response.createdAt,
                updatedAt: response.createdAt,
              }),
            })
        }
        const viewer = await buildViewerVisibilityContext(ctx, ids.creator)
        let responseReads = 0
        // Wrap real query builders, counting documents yielded by their iterators.
        function instrument<T extends object>(target: T): T {
          return new Proxy(target, {
            get(target, property) {
              const value: unknown = Reflect.get(target, property, target)
              if (typeof value !== 'function') return value
              if (property === Symbol.asyncIterator) {
                return async function* () {
                  const iterator = Reflect.apply(
                    value,
                    target,
                    [],
                  ) as AsyncIterableIterator<unknown>
                  try {
                    while (true) {
                      const next = await iterator.next()
                      if (next.done) break
                      responseReads++
                      yield next.value
                    }
                  } finally {
                    await iterator.return?.()
                  }
                }
              }
              return (...args: unknown[]) => {
                const result: unknown = Reflect.apply(value, target, args)
                if (
                  typeof result === 'object' &&
                  result !== null &&
                  Symbol.asyncIterator in result
                ) {
                  return instrument(result)
                }
                return result
              }
            },
          })
        }
        const original = ctx.db.query.bind(ctx.db)
        const query = vi.spyOn(ctx.db, 'query').mockImplementation((...args) => {
          const result = original(...args)
          return args[0] === 'bondfireVideos' ? instrument(result) : result
        })
        try {
          const summary = await buildThreadSummary(ctx, {
            bondfire,
            viewer,
            viewerId: ids.creator,
            pinnedUserIds: new Set(),
          })
          expect(responseReads).toBe(expectedReads) // Mux: 20 in sequence order + 20 chronological + lookahead.
          expect(summary?.participants.slice(0, 4).map((p) => p.user._id)).toEqual([
            authors[0],
            authors[3],
            authors[2],
            authors[1],
          ])
          expect(summary?.videoCount).toBe(301)
          expect(summary?.lastActivityAt).toBe(31_000)
          expect(summary?.unread).toBe(true)
          expect(summary?.latestResponseMuxPlaybackId).toBe(
            playback === 'mux' ? 'response-300' : undefined,
          )
        } finally {
          query.mockRestore()
        }
      })
    },
  )

  it.each(['read', 'unread', 'own-latest'] as const)(
    'keeps chronological activity and %s state when sequence order disagrees',
    async (state) => {
      const { t, ids } = await longThread()
      await t.run(async (ctx) => {
        await ctx.db.patch(ids.responderVideoId, {
          createdAt: 50_000,
          userId: state === 'own-latest' ? ids.creator : ids.responder,
        })
        // updatedAt may reflect metadata/repair writes, not visible activity.
        await ctx.db.patch(ids.bondfireId, { updatedAt: 90_000 })
      })
      await markThreadRead(t, ids.creator, ids.bondfireId, state === 'read' ? 60_000 : 40_000)
      const [thread] = await t
        .withIdentity({ subject: ids.creator })
        .query(api.conversations.listMyFires, {})
      expect(thread.lastActivityAt).toBe(50_000)
      expect(thread.unread).toBe(state === 'unread')
      expect(thread.latestResponseMuxPlaybackId).toBe('response-300')
      expect(thread.videoCount).toBe(301)
    },
  )

  it('keeps an older fourth avatar after a window dominated by one author', async () => {
    const { t, ids, authors } = await longThread()
    await t.run(async (ctx) => {
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', ids.bondfireId))
        .order('desc')
        .take(40)
      for (const response of responses) await ctx.db.patch(response._id, { userId: authors[0] })
    })
    const [thread] = await t
      .withIdentity({ subject: ids.creator })
      .query(api.conversations.listMyFires, {})
    expect(thread.participants.slice(0, 4).map((p) => p.user._id)).toEqual([
      authors[0],
      authors[3],
      authors[2],
      authors[1],
    ])
    expect(thread.lastActivityAt).toBe(31_000)
    expect(thread.unread).toBe(true)
  })

  it.each(['blocked', 'suspended', 'removed', 'pending_review', 'processing'] as const)(
    'looks past a full window of %s responses without making activity stale',
    async (state) => {
      const { t, ids, authors } = await longThread()
      await t.run(async (ctx) => {
        const hidden = await ctx.db.insert('users', {
          ...profile,
          displayName: 'Hidden',
          ...(state === 'suspended' ? { moderationStatus: 'suspended' as const } : {}),
        })
        if (state === 'blocked')
          await ctx.db.insert('userBlocks', {
            blockerId: hidden,
            blockedUserId: ids.creator,
            createdAt: 40_000,
          })
        const responses = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', ids.bondfireId))
          .order('desc')
          .take(25)
        for (const response of responses)
          await ctx.db.patch(response._id, {
            userId: hidden,
            ...(state === 'removed' || state === 'pending_review'
              ? { moderationStatus: state }
              : {}),
            ...(state === 'processing' ? { videoStatus: state } : {}),
          })
        await ctx.db.insert('closeCirclePins', {
          ownerId: ids.creator,
          pinnedUserId: authors[0],
          order: 0,
          createdAt: 100,
          updatedAt: 100,
        })
      })
      await markThreadRead(t, ids.creator, ids.bondfireId, 28_000)
      const viewer = t.withIdentity({ subject: ids.creator })
      const [thread] = await viewer.query(api.conversations.listMyFires, {})
      const [circle] = await viewer.query(api.conversations.listCloseCircle, {})
      for (const summary of [thread, circle.sharedThreads[0]]) {
        expect(summary.lastActivityAt).toBe(28_500)
        expect(summary.unread).toBe(true)
        expect(summary.videoCount).toBe(301)
        expect(summary.latestResponseMuxPlaybackId).toBe('response-275')
        expect(summary.participants.slice(0, 4).map((p) => p.user._id)).toEqual([
          authors[3],
          authors[2],
          authors[1],
          authors[0],
        ])
      }
    },
  )

  it('finishes activity timestamp ties before deciding whether the viewer has read the row', async () => {
    const { t, ids } = await longThread()
    await t.run(async (ctx) => {
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', ids.bondfireId))
        .order('desc')
        .take(25)
      for (const response of responses) await ctx.db.patch(response._id, { createdAt: 50_000 })
      await ctx.db.patch(responses[24]._id, { userId: ids.creator })
    })
    const [thread] = await t
      .withIdentity({ subject: ids.creator })
      .query(api.conversations.listMyFires, {})
    expect(thread.lastActivityAt).toBe(50_000)
    expect(thread.unread).toBe(false)
    expect(thread.firstUnwatchedResponder).toBeNull()
  })
})
