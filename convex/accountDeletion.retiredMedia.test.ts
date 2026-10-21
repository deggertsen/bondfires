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
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 1,
    awaitingConfirmation: 1,
  })
  expect(await t.run((ctx) => ctx.db.get(mediaId))).toMatchObject({ status: 'pending' })
  vi.stubEnv('LEGACY_MEDIA_RETIREMENT_CONFIRMED', '1')
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 1,
    awaitingConfirmation: 0,
  })
  expect(await t.run((ctx) => ctx.db.get(mediaId))).toMatchObject({ status: 'retired' })
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 0,
    awaitingConfirmation: 0,
  })
  const archived = await t.run((ctx) => ctx.db.query('retentionMedia').collect())
  expect(archived).toHaveLength(1)
  expect(archived[0]).toMatchObject({ externalId: 'retained-backup', kind: 'asset' })
  expect(fetch).not.toHaveBeenCalled()
})

it('retires all resource kinds in bounded batches and retains the ledger after the account queue is removed', async () => {
  const t = convexTest(schema, modules)
  vi.stubEnv('LEGACY_MEDIA_RETIREMENT_CONFIRMED', '1')
  const jobId = await t.run(async (ctx) => {
    const jobId = await ctx.db.insert('accountDeletionJobs', {
      status: 'media',
      attempts: 0,
      requestedAt: 1,
      updatedAt: 1,
    })
    const kinds = [
      'asset',
      'direct_upload',
      'live_stream',
      'asset',
      'asset',
      'asset',
      'asset',
      'asset',
      'asset',
    ] as const
    for (const [index, kind] of kinds.entries()) {
      await ctx.db.insert('accountDeletionMedia', {
        jobId,
        kind,
        externalId: `resource-${index}`,
        status: 'pending',
        attempts: 0,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    // Completed work from before retirement must not be revisited or archived.
    await ctx.db.insert('accountDeletionMedia', {
      jobId,
      kind: 'asset',
      externalId: 'already-deleted',
      status: 'deleted',
      attempts: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    return jobId
  })
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 8,
    awaitingConfirmation: 0,
  })
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 1,
    awaitingConfirmation: 0,
  })
  vi.stubEnv('LEGACY_MEDIA_RETIREMENT_CONFIRMED', '')
  expect(await t.mutation(internal.accountDeletion.retireMediaBatch, { jobId })).toEqual({
    processed: 0,
    awaitingConfirmation: 0,
  })
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('accountDeletionMedia').collect()) {
      expect(['retired', 'deleted']).toContain(row.status)
      await ctx.db.delete(row._id)
    }
  })
  const archived = await t.run((ctx) => ctx.db.query('retentionMedia').collect())
  expect(archived.map((row) => row.externalId).sort()).toEqual([
    'resource-0',
    'resource-1',
    'resource-2',
    'resource-3',
    'resource-4',
    'resource-5',
    'resource-6',
    'resource-7',
    'resource-8',
  ])
})
