/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, expect, it, vi } from 'vitest'
import { internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('preserves external cleanup work and waits for confirmed retirement before completing media deletion', async () => {
  const t = convexTest(schema, modules)
  const fetch = vi.fn(() => {
    throw new Error('Unexpected retired provider request')
  })
  vi.stubGlobal('fetch', fetch)
  vi.stubEnv('LEGACY_MEDIA_RETIREMENT_CONFIRMED', '')
  const { jobId, mediaId } = await t.run(async (ctx) => {
    const jobId = await ctx.db.insert('accountDeletionJobs', {
      status: 'media',
      attempts: 0,
      requestedAt: 1,
      updatedAt: 1,
    })
    const mediaId = await ctx.db.insert('accountDeletionMedia', {
      jobId,
      kind: 'asset',
      externalId: 'retained-backup',
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    return { jobId, mediaId }
  })
  expect(await t.action(internal.accountDeletion.deleteMediaBatch, { jobId })).toEqual({
    processed: 1,
    failures: 1,
  })
  expect(await t.run((ctx) => ctx.db.get(mediaId))).toMatchObject({ status: 'pending' })
  vi.stubEnv('LEGACY_MEDIA_RETIREMENT_CONFIRMED', '1')
  expect(await t.action(internal.accountDeletion.deleteMediaBatch, { jobId })).toEqual({
    processed: 1,
    failures: 0,
  })
  expect(await t.run((ctx) => ctx.db.get(mediaId))).toMatchObject({ status: 'retired' })
  const archived = await t.run((ctx) => ctx.db.query('retentionMedia').collect())
  expect(archived).toHaveLength(1)
  expect(archived[0]).toMatchObject({ externalId: 'retained-backup', kind: 'asset' })
  expect(fetch).not.toHaveBeenCalled()
})
