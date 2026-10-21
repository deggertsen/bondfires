/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { hasNewReactionsForViewer } from './conversations'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const profile = {
      birthDate: '1990-01-01',
      gender: 'other' as const,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    }
    const owner = await ctx.db.insert('users', profile)
    const responder = await ctx.db.insert('users', profile)
    const viewer = await ctx.db.insert('users', profile)
    const outsider = await ctx.db.insert('users', profile)
    const camp = await ctx.db.insert('camps', {
      name: 'Reactions',
      slug: 'reactions',
      purpose: 'Test',
      access: 'invite',
      status: 'active',
      ageBand: 'adult',
      ownerId: owner,
      rules: { access: {}, participation: {}, advisory: {} },
      createdAt: now,
      updatedAt: now,
    })
    for (const userId of [owner, responder, viewer, outsider])
      await ctx.db.insert('campMembers', {
        userId,
        campId: camp,
        role: 'member',
        status: 'active',
        muted: false,
        createdAt: now,
        updatedAt: now,
      })
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: owner,
      campId: camp,
      videoStatus: 'ready',
      muxPlaybackId: 'spark',
      videoCount: 2,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    const responseId = await ctx.db.insert('bondfireVideos', {
      userId: responder,
      bondfireId,
      sequenceNumber: 1,
      videoStatus: 'ready',
      muxPlaybackId: 'response',
      countedAt: now,
      createdAt: now,
    })
    return { owner, responder, viewer, outsider, bondfireId, responseId }
  })
  const as = (userId: Id<'users'>) => t.withIdentity({ subject: userId })
  const docs = () =>
    t.run(async (ctx) => ({
      bondfire: await ctx.db.get(ids.bondfireId),
      response: await ctx.db.get(ids.responseId),
    }))
  return { t, ids, as, docs }
}

describe('reaction summaries', () => {
  it('counts a spark reaction on the spark and the thread, a response reaction on the response and the thread', async () => {
    const { ids, as, docs } = await fixture()
    const viewer = as(ids.viewer)
    await viewer.mutation(api.videoReactions.addReaction, {
      bondfireId: ids.bondfireId,
      emoji: '❤️',
      timestampMs: 100,
    })
    await viewer.mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🔥',
      timestampMs: 200,
    })
    await viewer.mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🔥',
      timestampMs: 300,
    })

    const { bondfire, response } = await docs()
    expect(bondfire?.reactionTotal).toBe(1)
    expect(bondfire?.reactionCounts).toEqual([{ emoji: '❤️', count: 1 }])
    expect(bondfire?.threadReactionTotal).toBe(3)
    expect(bondfire?.threadReactionCounts).toEqual([
      { emoji: '🔥', count: 2 },
      { emoji: '❤️', count: 1 },
    ])
    expect(bondfire?.threadLastReactorId).toBe(ids.viewer)
    expect(bondfire?.threadLastReactionAt).toBeTypeOf('number')
    expect(response?.reactionTotal).toBe(2)
    expect(response?.reactionCounts).toEqual([{ emoji: '🔥', count: 2 }])
  })

  it('leaves summaries untouched when a reaction is rejected', async () => {
    const { t, ids, as, docs } = await fixture()
    const viewer = as(ids.viewer)
    const before = await docs()
    await expect(
      viewer.mutation(api.videoReactions.addReaction, {
        bondfireId: ids.bondfireId,
        emoji: 'not-an-emoji',
        timestampMs: 100,
      }),
    ).rejects.toThrow()
    await expect(
      viewer.mutation(api.videoReactions.addReaction, {
        bondfireId: ids.bondfireId,
        emoji: '🔥',
        timestampMs: -1,
      }),
    ).rejects.toThrow()
    for (let i = 0; i < 10; i++)
      await viewer.mutation(api.videoReactions.addReaction, {
        bondfireId: ids.bondfireId,
        emoji: '🔥',
        timestampMs: i,
      })
    const afterTen = await docs()
    await expect(
      viewer.mutation(api.videoReactions.addReaction, {
        bondfireId: ids.bondfireId,
        emoji: '🔥',
        timestampMs: 11,
      }),
    ).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(ids.responseId))
    await expect(
      viewer.mutation(api.videoReactions.addReaction, {
        bondfireVideoId: ids.responseId,
        emoji: '🔥',
        timestampMs: 1,
      }),
    ).rejects.toThrow()

    expect(before.bondfire?.threadReactionTotal).toBeUndefined()
    expect(afterTen.bondfire?.threadReactionTotal).toBe(10)
    expect((await docs()).bondfire?.threadReactionTotal).toBe(10)
  })

  it('marks reactions new for participants until they open the thread', async () => {
    const { t, ids, as } = await fixture()
    const check = (userId: Id<'users'>) =>
      t.run(async (ctx) => {
        const bondfire = await ctx.db.get(ids.bondfireId)
        if (!bondfire) throw new Error('missing bondfire')
        return await hasNewReactionsForViewer(ctx, bondfire, userId)
      })

    expect(await check(ids.owner)).toBe(false)
    await as(ids.viewer).mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🙏',
      timestampMs: 100,
    })
    expect(await check(ids.owner)).toBe(true)
    expect(await check(ids.responder)).toBe(true)
    // The reactor's own reaction is not news to them, and outsiders never see it.
    expect(await check(ids.viewer)).toBe(false)
    expect(await check(ids.outsider)).toBe(false)

    await as(ids.owner).mutation(api.conversations.markThreadRead, { bondfireId: ids.bondfireId })
    expect(await check(ids.owner)).toBe(false)
    expect(await check(ids.responder)).toBe(true)
  })

  it('removes a deleted reactor’s counts from the video and the thread, and a rerun cannot go negative', async () => {
    const { t, ids, as, docs } = await fixture()
    await as(ids.viewer).mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🔥',
      timestampMs: 100,
    })
    await as(ids.outsider).mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🔥',
      timestampMs: 200,
    })
    const jobId = await t.run((ctx) =>
      ctx.db.insert('accountDeletionJobs', {
        userId: ids.viewer,
        status: 'database',
        cleanupStage: 'reactions',
        attempts: 0,
        requestedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    await t.mutation(internal.accountDeletion.cleanupUserBatch, { jobId })
    await t.run((ctx) => ctx.db.patch(jobId, { cleanupStage: 'reactions' }))
    await t.mutation(internal.accountDeletion.cleanupUserBatch, { jobId })

    const { bondfire, response } = await docs()
    const remaining = await t.run((ctx) =>
      ctx.db
        .query('videoReactions')
        .withIndex('by_user_created', (q) => q.eq('userId', ids.viewer))
        .collect(),
    )
    expect(remaining).toEqual([])
    expect(response?.reactionTotal).toBe(1)
    expect(bondfire?.threadReactionTotal).toBe(1)
    expect(bondfire?.threadReactionCounts).toEqual([{ emoji: '🔥', count: 1 }])
  })

  it('subtracts a retained response’s reactions from the surviving thread', async () => {
    const { t, ids, as, docs } = await fixture()
    const viewer = as(ids.viewer)
    await viewer.mutation(api.videoReactions.addReaction, {
      bondfireId: ids.bondfireId,
      emoji: '❤️',
      timestampMs: 100,
    })
    await viewer.mutation(api.videoReactions.addReaction, {
      bondfireVideoId: ids.responseId,
      emoji: '🔥',
      timestampMs: 100,
    })
    const jobId = await t.run((ctx) =>
      ctx.db.insert('retentionCleanupJobs', {
        kind: 'response',
        recordId: ids.responseId,
        stage: 2, // VIDEO_STAGES[2] === 'reactions'
        revision: 0,
        updatedAt: Date.now(),
      }),
    )
    await t.mutation(internal.retentionCleanup.runBatch, { jobId, revision: 0 })

    const { bondfire } = await docs()
    expect(bondfire?.threadReactionTotal).toBe(1)
    expect(bondfire?.threadReactionCounts).toEqual([{ emoji: '❤️', count: 1 }])
    expect(bondfire?.reactionTotal).toBe(1)
  })

  it('backfills summaries from raw rows and is safe to rerun', async () => {
    const { t, ids, docs } = await fixture()
    await t.run(async (ctx) => {
      const row = { userId: ids.viewer, timestampMs: 0 }
      await ctx.db.insert('videoReactions', {
        ...row,
        bondfireId: ids.bondfireId,
        emoji: '🙏',
        createdAt: 1,
      })
      await ctx.db.insert('videoReactions', {
        ...row,
        bondfireVideoId: ids.responseId,
        emoji: '🙏',
        createdAt: 2,
      })
      await ctx.db.insert('videoReactions', {
        ...row,
        userId: ids.outsider,
        bondfireVideoId: ids.responseId,
        emoji: '❤️',
        createdAt: 3,
      })
    })

    const first = await t.mutation(internal.videoReactions.repairReactionSummaries, {})
    const { bondfire, response } = await docs()
    expect(first.repaired).toBe(2)
    expect(bondfire?.reactionTotal).toBe(1)
    expect(bondfire?.threadReactionTotal).toBe(3)
    expect(bondfire?.threadReactionCounts).toEqual([
      { emoji: '🙏', count: 2 },
      { emoji: '❤️', count: 1 },
    ])
    expect(bondfire?.threadLastReactionAt).toBe(3)
    expect(bondfire?.threadLastReactorId).toBe(ids.outsider)
    expect(response?.reactionTotal).toBe(2)

    const second = await t.mutation(internal.videoReactions.repairReactionSummaries, {})
    expect(second.repaired).toBe(0)
  })

  it('keeps the list count even when playback hides a blocked reactor', async () => {
    const { t, ids, as, docs } = await fixture()
    await as(ids.viewer).mutation(api.videoReactions.addReaction, {
      bondfireId: ids.bondfireId,
      emoji: '🔥',
      timestampMs: 100,
    })
    await t.run((ctx) =>
      ctx.db.insert('userBlocks', {
        blockerId: ids.owner,
        blockedUserId: ids.viewer,
        createdAt: Date.now(),
      }),
    )
    expect(
      await as(ids.owner).query(api.videoReactions.getReactions, { bondfireId: ids.bondfireId }),
    ).toEqual([])
    expect((await docs()).bondfire?.threadReactionTotal).toBe(1)
  })
})
