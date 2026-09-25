/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
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
 * A creator sparks a Bondfire, a responder replies, then the creator replies
 * back. Timestamps ascend so `by_bondfire_created` ordering is deterministic.
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

async function resolveResponder(
  t: ReturnType<typeof convexTest>,
  bondfireId: Id<'bondfires'>,
  viewerId: Id<'users'>,
  lastReadAt = 0,
) {
  return await t.run(async (ctx) => {
    const bondfire = await ctx.db.get(bondfireId)
    if (!bondfire) throw new Error('Missing fixture bondfire')
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    return await getFirstUnwatchedResponder(ctx, { bondfire, viewerId, viewer, lastReadAt })
  })
}

describe('getFirstUnwatchedResponder', () => {
  it('names the creator when the viewer has not watched the spark', async () => {
    const { t, ids } = await fixture()
    const result = await resolveResponder(t, ids.bondfireId, ids.responder)
    expect(result?._id).toBe(ids.creator)
    expect(result?.displayName).toBe('Creator')
  })

  it('names the responder of the first unwatched response once the spark is watched', async () => {
    const { t, ids } = await fixture()
    await markWatched(t, ids.other, ids.bondfireId, 'bondfire')
    const result = await resolveResponder(t, ids.bondfireId, ids.other)
    expect(result?._id).toBe(ids.responder)
    expect(result?.displayName).toBe('Responder')
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
  })

  it('returns null when every video in the thread is watched', async () => {
    const { t, ids } = await fixture()
    await markWatched(t, ids.creator, ids.responderVideoId, 'response')
    await markWatched(t, ids.creator, ids.otherVideoId, 'response')
    const result = await resolveResponder(t, ids.bondfireId, ids.creator)
    expect(result).toBeNull()
  })

  it('only scans responses newer than the thread read marker', async () => {
    const { t, ids } = await fixture()
    // Read marker sits after the responder's video but before Other's.
    const result = await resolveResponder(t, ids.bondfireId, ids.creator, 1_250)
    expect(result?._id).toBe(ids.other)
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
})
