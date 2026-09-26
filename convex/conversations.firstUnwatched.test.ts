/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { buildViewerVisibilityContext } from './bondfireVisibility'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { getFirstUnwatchedResponder } from './conversations'
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
      eventType: 'start',
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

  it('names the first unwatched responder beyond 250 responses instead of the latest participant', async () => {
    const { t, ids } = await fixture()
    await markWatched(t, ids.creator, ids.responderVideoId, 'response')
    await markWatched(t, ids.creator, ids.otherVideoId, 'response')
    await t.run(async (ctx) => {
      for (let sequenceNumber = 4; sequenceNumber <= 252; sequenceNumber++) {
        const userId =
          sequenceNumber === 251 ? ids.responder : sequenceNumber === 252 ? ids.other : ids.creator
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
