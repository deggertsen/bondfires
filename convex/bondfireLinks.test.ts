/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

describe('Bondfire detail links', () => {
  it('returns unavailable for malformed and wrong-table IDs in every detail subscription', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.run((ctx) => ctx.db.insert('users', { gender: 'other' }))
    // A saved route from another deployment can decode as a different table.
    for (const bondfireId of ['', 'not-an-id', userId]) {
      expect(await t.query(api.bondfires.getWithVideos, { bondfireId })).toBeNull()
      expect(await t.query(api.bondfires.getWithCampContext, { id: bondfireId })).toBeNull()
      expect(await t.query(api.bondfires.getUnavailableReason, { bondfireId })).toMatchObject({
        reason: 'invalid_link',
      })
    }
  })

  it('preserves valid draft access and handles deleted destinations without throwing', async () => {
    const t = convexTest(schema, modules)
    const { userId, bondfireId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { gender: 'other' })
      const bondfireId = await ctx.db.insert('bondfires', {
        userId,
        videoStatus: 'pending',
        videoCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      return { userId, bondfireId }
    })
    const owner = t.withIdentity({ subject: userId })
    expect(await owner.query(api.bondfires.getWithVideos, { bondfireId })).toMatchObject({
      _id: bondfireId,
      videoStatus: 'pending',
    })
    expect(await owner.query(api.bondfires.getWithCampContext, { id: bondfireId })).toMatchObject({
      bondfire: { _id: bondfireId },
    })
    await t.run((ctx) => ctx.db.delete(bondfireId))
    expect(await owner.query(api.bondfires.getWithVideos, { bondfireId })).toBeNull()
    expect(await owner.query(api.bondfires.getWithCampContext, { id: bondfireId })).toBeNull()
    expect(await owner.query(api.bondfires.getUnavailableReason, { bondfireId })).toMatchObject({
      reason: 'deleted',
    })
  })
})
