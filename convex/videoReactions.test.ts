/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
async function fixture(provider: 'mux' | 'segment', response: boolean) {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const profile = {
      birthDate: '1990-01-01',
      gender: 'other' as const,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    }
    const owner = await ctx.db.insert('users', profile)
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    let membership: Id<'campMembers'> | undefined
    for (const userId of [owner, viewer])
      membership = await ctx.db.insert('campMembers', {
        userId,
        campId: camp,
        role: 'member',
        status: 'active',
        muted: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    const segmentRecordingId = await ctx.db.insert('segmentRecordings', {
      userId: owner,
      localId: 'reaction-test',
      status: 'ready',
      segmentCount: 1,
      finalCount: 1,
      duration: 2,
      maxDuration: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const media = provider === 'mux' ? { muxPlaybackId: 'vod' } : { segmentRecordingId }
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: owner,
      campId: camp,
      videoStatus: 'ready',
      ...media,
      videoCount: 1,
      viewCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const bondfireVideoId = await ctx.db.insert('bondfireVideos', {
      userId: owner,
      bondfireId,
      sequenceNumber: 1,
      videoStatus: 'ready',
      ...media,
      createdAt: Date.now(),
    })
    if (!membership) throw new Error('Missing fixture membership')
    return { owner, viewer, outsider, membership, bondfireId, bondfireVideoId }
  })
  const viewer = t.withIdentity({ subject: ids.viewer })
  const ref = response ? { bondfireVideoId: ids.bondfireVideoId } : { bondfireId: ids.bondfireId }
  return { t, ids, viewer, ref, targetId: response ? ids.bondfireVideoId : ids.bondfireId }
}
describe('VOD reactions across media providers', () => {
  for (const provider of ['mux', 'segment'] as const)
    for (const response of [false, true]) {
      it(`reads and writes ${provider} ${response ? 'responses' : 'Bondfires'} and handles revoked access`, async () => {
        const { t, ids, viewer, ref } = await fixture(provider, response)
        expect(await viewer.query(api.videoReactions.getReactions, ref)).toEqual([])
        await viewer.mutation(api.videoReactions.addReaction, {
          ...ref,
          emoji: '🔥',
          timestampMs: 100,
        })
        expect(await viewer.query(api.videoReactions.getReactions, ref)).toHaveLength(1)
        const outsider = t.withIdentity({ subject: ids.outsider })
        expect(await outsider.query(api.videoReactions.getReactions, ref)).toEqual([])
        await expect(
          outsider.mutation(api.videoReactions.addReaction, {
            ...ref,
            emoji: '🔥',
            timestampMs: 100,
          }),
        ).rejects.toThrow()
        await t.run((ctx) => ctx.db.delete(ids.membership))
        expect(await viewer.query(api.videoReactions.getReactions, ref)).toEqual([])
        await expect(
          viewer.mutation(api.videoReactions.addReaction, {
            ...ref,
            emoji: '🔥',
            timestampMs: 100,
          }),
        ).rejects.toThrow()
      })
    }
  it.each(['pending', 'waiting_for_upload', 'live', 'errored'] as const)(
    'does not crash a read subscription in %s, but rejects writes',
    async (videoStatus) => {
      const { t, viewer, ref, targetId } = await fixture('segment', false)
      await t.run((ctx) => ctx.db.patch(targetId, { videoStatus }))
      expect(await viewer.query(api.videoReactions.getReactions, ref)).toEqual([])
      await expect(
        viewer.mutation(api.videoReactions.addReaction, { ...ref, emoji: '🔥', timestampMs: 100 }),
      ).rejects.toThrow()
    },
  )
  it('returns no reactions for expired or deleted videos', async () => {
    const { t, viewer, ref, targetId } = await fixture('segment', true)
    await t.run((ctx) => ctx.db.patch(targetId, { expiresAt: Date.now() - 1 }))
    expect(await viewer.query(api.videoReactions.getReactions, ref)).toEqual([])
    await t.run((ctx) => ctx.db.delete(targetId))
    expect(await viewer.query(api.videoReactions.getReactions, ref)).toEqual([])
  })
})
