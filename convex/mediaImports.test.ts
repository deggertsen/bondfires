/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
async function fixture() {
  const t = convexTest(schema, modules)
  const data = await t.run(async (ctx) => {
    const owner = await ctx.db.insert('users', { birthDate: '1990-01-01', gender: 'other' })
    const viewer = await ctx.db.insert('users', { birthDate: '1990-01-01', gender: 'other' })
    const campId = await ctx.db.insert('camps', {
      slug: 'import',
      name: 'Import',
      purpose: 'Test',
      access: 'invite',
      status: 'active',
      ageBand: 'adult',
      ownerId: owner,
      rules: { access: {}, participation: {}, advisory: {} },
      createdAt: 1,
      updatedAt: 1,
    })
    let memberId: import('./_generated/dataModel').Id<'campMembers'> | undefined
    for (const userId of [owner, viewer]) {
      const id = await ctx.db.insert('campMembers', {
        userId,
        campId,
        role: userId === owner ? 'owner' : 'member',
        status: 'active',
        muted: true,
        createdAt: 1,
        updatedAt: 1,
      })
      if (userId === viewer) memberId = id
    }
    const recordId = await ctx.db.insert('bondfires', {
      userId: owner,
      campId,
      videoStatus: 'ready',
      muxAssetId: 'asset',
      muxPlaybackId: 'playback',
      muxPlaybackPolicy: 'signed',
      videoCount: 7,
      createdAt: 1,
      updatedAt: 2,
    })
    return { owner, viewer, recordId, memberId }
  })
  const args = { recordId: data.recordId, muxAssetId: 'asset', muxPlaybackId: 'playback' }
  const importId = await t.mutation(internal.mediaImports.stage, args)
  const activate = () =>
    t.mutation(internal.mediaImports.activate, {
      importId,
      manifestChecksum: 'a'.repeat(64),
      duration: 13,
    })
  return { t, ...data, args, importId, activate }
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('historical media imports', () => {
  it('stages idempotently, switches without modifying records or sending notifications, and rolls back', async () => {
    const { t, args, recordId, importId, activate } = await fixture()
    const before = await t.run((ctx) => ctx.db.get(recordId))
    expect(await t.mutation(internal.mediaImports.stage, args)).toBe(importId)
    expect(
      await t.query(internal.mediaImports.lookup, { recordId, muxPlaybackId: 'playback' }),
    ).toBeNull()
    await activate()
    await activate()
    expect(await t.run((ctx) => ctx.db.get(recordId))).toEqual(before)
    expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual([])
    expect(
      await t.query(internal.mediaImports.lookup, { recordId, muxPlaybackId: 'playback' }),
    ).toMatchObject({ status: 'ready' })
    await t.mutation(internal.mediaImports.rollback, { importId })
    expect(
      await t.query(internal.mediaImports.lookup, { recordId, muxPlaybackId: 'playback' }),
    ).toBeNull()
    await expect(t.query(internal.mediaImports.authorize, { importId })).rejects.toThrow()
  })
  it('rejects changed sources, deleted records, and overwriting verified imports', async () => {
    const { t, recordId, importId, activate } = await fixture()
    await activate()
    await expect(
      t.mutation(internal.mediaImports.activate, {
        importId,
        manifestChecksum: 'b'.repeat(64),
        duration: 13,
      }),
    ).rejects.toThrow('immutable')
    await t.run((ctx) => ctx.db.patch(recordId, { muxAssetId: 'replacement' }))
    await expect(activate()).rejects.toThrow('Source changed')
    await t.run((ctx) => ctx.db.delete(recordId))
    await expect(activate()).rejects.toThrow('Source changed')
    expect((await t.query(internal.mediaImports.orphanPage, { cursor: null })).page).toEqual([
      importId,
    ])
  })
  it('returns all R2 URLs to current members and revokes reads immediately on removal/deletion', async () => {
    vi.stubEnv('MEDIA_TOKEN_SECRET', 'x'.repeat(32))
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.test')
    const { t, viewer, memberId, recordId, importId, activate } = await fixture()
    await activate()
    const urls = await t
      .withIdentity({ subject: viewer })
      .action(api.videos.getVideoUrls, { bondfireId: recordId, muxPlaybackId: 'playback' })
    expect(urls.hdUrl).toContain(`/imports/${importId}/index.m3u8?token=`)
    expect(urls.captionsUrl).toContain('/captions.vtt?token=')
    expect(urls.thumbnailUrl).toContain('/thumbnail.jpg?token=')
    expect(await t.query(internal.mediaImports.authorize, { importId, userId: viewer })).toEqual({
      manifestChecksum: 'a'.repeat(64),
    })
    if (!memberId) throw Error('Missing member')
    await t.run((ctx) => ctx.db.delete(memberId))
    await expect(
      t.query(internal.mediaImports.authorize, { importId, userId: viewer }),
    ).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(recordId))
    await expect(
      t.query(internal.mediaImports.authorize, { importId, userId: viewer }),
    ).rejects.toThrow()
  })
  it('supports record-only and installed-client requests without contacting Mux', async () => {
    vi.stubEnv('MEDIA_TOKEN_SECRET', 'x'.repeat(32))
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.test')
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider request')
    })
    vi.stubGlobal('fetch', fetch)
    const { t, viewer, recordId, importId, activate } = await fixture()
    await activate()
    const client = t.withIdentity({ subject: viewer })
    for (const request of [
      { bondfireId: recordId },
      { bondfireId: recordId, muxPlaybackId: 'playback' },
    ]) {
      const result = await client.action(api.videos.getVideoUrls, request)
      expect(result.hdUrl).toContain(`/imports/${importId}/index.m3u8?token=`)
      expect(result.captionsUrl).toContain(`/imports/${importId}/captions.vtt?token=`)
      const thumbnail = await client.action(api.videos.getThumbnailUrl, request)
      expect(thumbnail.thumbnailUrl).toContain(`/imports/${importId}/thumbnail.jpg?token=`)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed for absent, stale, rolled-back, and unauthorized imports in mixed batches', async () => {
    vi.stubEnv('MEDIA_TOKEN_SECRET', 'x'.repeat(32))
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.test')
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider request')
    })
    vi.stubGlobal('fetch', fetch)
    const { t, viewer, recordId, importId, activate, memberId } = await fixture()
    const client = t.withIdentity({ subject: viewer })
    expect((await client.action(api.videos.getVideoUrls, { bondfireId: recordId })).hdUrl).toBe('')
    await activate()
    const results = await client.action(api.videos.getVideoUrlsBatch, {
      items: [
        { bondfireId: recordId, muxPlaybackId: 'stale' },
        { muxPlaybackId: 'no-record' },
        { bondfireId: recordId },
      ],
    })
    expect(results.map((r) => Boolean(r.hdUrl))).toEqual([false, false, true])
    if (!memberId) throw new Error('Missing membership')
    await t.run((ctx) => ctx.db.delete(memberId))
    expect((await client.action(api.videos.getVideoUrls, { bondfireId: recordId })).hdUrl).toBe('')
    expect(
      (await client.action(api.videos.getThumbnailUrl, { bondfireId: recordId })).thumbnailUrl,
    ).toBe('')
    await t.mutation(internal.mediaImports.rollback, { importId })
    expect((await client.action(api.videos.getVideoUrls, { bondfireId: recordId })).hdUrl).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to an authorized imported spark thumbnail for a native R2 response', async () => {
    vi.stubEnv('MEDIA_TOKEN_SECRET', 'x'.repeat(32))
    vi.stubEnv('MEDIA_WORKER_URL', 'https://media.test')
    const { t, owner, viewer, recordId, importId, activate } = await fixture()
    await activate()
    const responseId = await t.run(async (ctx) =>
      ctx.db.insert('bondfireVideos', {
        bondfireId: recordId,
        userId: owner,
        sequenceNumber: 1,
        videoStatus: 'ready',
        createdAt: 3,
        segmentRecordingId: await ctx.db.insert('segmentRecordings', {
          userId: owner,
          localId: 'native',
          status: 'ready',
          segmentCount: 1,
          duration: 3,
          maxDuration: 60,
          createdAt: 3,
          updatedAt: 3,
        }),
      }),
    )
    const result = await t.withIdentity({ subject: viewer }).action(api.videos.getThumbnailUrl, {
      bondfireId: recordId,
      bondfireVideoId: responseId,
    })
    expect(result.thumbnailUrl).toContain(`/imports/${importId}/thumbnail.jpg?token=`)
  })
})
