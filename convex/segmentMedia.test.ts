/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { cancelSegmentMedia } from './lib/segmentMediaCleanup'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
async function setup() {
  const t = convexTest(schema, modules)
  const fixture = await t.run(async (ctx) => {
    const profile = {
      gender: 'other' as const,
      birthDate: '1990-01-01',
      forcedTier: 'pro' as const,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    }
    const owner = await ctx.db.insert('users', profile)
    const viewer = await ctx.db.insert('users', profile)
    const outsider = await ctx.db.insert('users', profile)
    const campId = await ctx.db.insert('camps', {
      slug: 'media-test',
      name: 'Media',
      purpose: 'Test',
      access: 'invite',
      status: 'active',
      ageBand: 'adult',
      ownerId: owner,
      rules: { access: {}, participation: { maxDurationMs: 10000 }, advisory: {} },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const members = []
    for (const userId of [owner, viewer])
      members.push(
        await ctx.db.insert('campMembers', {
          userId,
          campId,
          role: userId === owner ? 'owner' : 'member',
          status: 'active',
          muted: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      )
    return { owner, viewer, outsider, campId, members }
  })
  const owner = t.withIdentity({ subject: fixture.owner })
  const args = {
    localId: '00000000-0000-4000-8000-000000000001',
    isResponse: false,
    campId: fixture.campId,
  }
  const record = await owner.mutation(api.segmentMedia.begin, args)
  const receipt = (index: number, duration = 4, checksum = 'a'.repeat(64)) =>
    t.mutation(internal.segmentMedia.receipt, {
      recordingId: record.recordingId,
      userId: fixture.owner,
      index,
      duration,
      size: 1000,
      checksum,
    })
  return { t, fixture, owner, args, record, receipt }
}
beforeEach(() => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://lovely-malamute-525.convex.cloud')
  vi.stubEnv('INTERNAL_SEGMENT_MEDIA', '1')
})
afterEach(() => vi.unstubAllEnvs())
describe('internal recording lifecycle', () => {
  it('recovers persisted null-draft uploads for both new Bondfires and responses', async () => {
    const { t, owner, args, record, receipt } = await setup()
    const root = await owner.mutation(api.segmentMedia.begin, {
      ...args,
      localId: '00000000-0000-4000-8000-000000000002',
      draftBondfireId: null,
    })
    expect((await t.run((ctx) => ctx.db.get(root.recordId)))?.segmentRecordingId).toBe(
      root.recordingId,
    )
    await receipt(-1, 0)
    await receipt(0)
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: record.recordingId,
      segmentCount: 1,
    })
    const responseArgs = {
      ...args,
      localId: '00000000-0000-4000-8000-000000000003',
      isResponse: true,
      bondfireId: record.recordId as import('./_generated/dataModel').Id<'bondfires'>,
      draftBondfireId: null,
    }
    const response = await owner.mutation(api.segmentMedia.begin, responseArgs)
    expect(await owner.mutation(api.segmentMedia.begin, responseArgs)).toEqual(response)
    expect(
      await owner.query(api.segmentMedia.getOwnRecording, {
        localId: responseArgs.localId,
      }),
    ).toEqual({
      bondfireId: record.recordId,
      responseId: response.recordId,
      videoStatus: 'waiting_for_upload',
    })
  })
  it('reveals upload destinations only to their owner and handles deleted records', async () => {
    const { t, owner, fixture, args, record } = await setup()
    expect(await owner.query(api.segmentMedia.getOwnRecording, { localId: args.localId })).toEqual({
      bondfireId: record.recordId,
      videoStatus: 'waiting_for_upload',
    })
    expect(await t.query(api.segmentMedia.getOwnRecording, { localId: args.localId })).toBeNull()
    expect(
      await t
        .withIdentity({ subject: fixture.viewer })
        .query(api.segmentMedia.getOwnRecording, { localId: args.localId }),
    ).toBeNull()
    await t.run((ctx) => ctx.db.delete(record.recordId))
    expect(
      await owner.query(api.segmentMedia.getOwnRecording, { localId: args.localId }),
    ).toBeNull()
  })
  it('is idempotent, exposes only complete prefixes, and finalizes after all receipts', async () => {
    const { t, owner, args, record, receipt } = await setup()
    expect((await owner.mutation(api.segmentMedia.begin, args)).recordingId).toBe(
      record.recordingId,
    )
    expect(record.maxDuration).toBe(10)
    await expect(receipt(0)).rejects.toThrow()
    await receipt(-1, 0)
    await expect(receipt(1)).rejects.toThrow()
    await receipt(0)
    await receipt(0)
    await expect(receipt(0, 4, 'b'.repeat(64))).rejects.toThrow()
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: record.recordingId,
      segmentCount: 3,
    })
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe(
      'waiting_for_upload',
    )
    await receipt(1)
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('live')
    await receipt(2, 2)
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('ready')
    await expect(
      owner.mutation(api.segmentMedia.finish, { recordingId: record.recordingId, segmentCount: 4 }),
    ).rejects.toThrow()
    await expect(receipt(3, 1)).rejects.toThrow()
  })
  it('denies nonmembers, rechecks membership and deletion, and enforces ownership', async () => {
    const { t, fixture, record, receipt } = await setup()
    const read = (userId: typeof fixture.owner) =>
      t.query(internal.segmentMedia.authorize, {
        recordingId: record.recordingId,
        userId,
        operation: 'read',
      })
    await read(fixture.viewer)
    await expect(read(fixture.outsider)).rejects.toThrow()
    await expect(
      t
        .withIdentity({ subject: fixture.viewer })
        .mutation(api.segmentMedia.finish, { recordingId: record.recordingId, segmentCount: 1 }),
    ).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(fixture.members[1]))
    await expect(read(fixture.viewer)).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(record.recordId))
    await expect(receipt(-1, 0)).rejects.toThrow()
  })
  it('enforces duration caps and requires separate production enablement', async () => {
    const { receipt, owner, args } = await setup()
    await receipt(-1, 0)
    await receipt(0, 6)
    await expect(receipt(1, 6)).rejects.toThrow()
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://ideal-akita-27.convex.cloud')
    await expect(owner.mutation(api.segmentMedia.begin, args)).rejects.toThrow(
      'Segment media is disabled',
    )
    vi.stubEnv('SEGMENT_MEDIA_ENABLED', '1')
    await expect(owner.mutation(api.segmentMedia.begin, args)).resolves.toMatchObject({
      recordingId: expect.any(String),
    })
  })
})

async function sharedDraft() {
  const base = await setup()
  const { t, fixture, owner } = base
  await t.run((ctx) =>
    ctx.db.insert('personalCamps', {
      publicId: 'test-hearth',
      ownerId: fixture.owner,
      name: 'Hearth',
      ageBand: 'adult',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  const draft = await owner.mutation(api.personalBondfires.createDraftBondfire, {
    title: 'Shared before recording',
  })
  const viewer = t.withIdentity({ subject: fixture.viewer })
  await viewer.mutation(api.personalBondfires.redeemInvite, { code: draft.inviteCode })
  const args = {
    localId: '00000000-0000-4000-8000-000000000002',
    isResponse: false,
    personalCamp: true,
    draftBondfireId: draft.bondfireId,
  }
  const detail = () => viewer.query(api.bondfires.getWithVideos, { bondfireId: draft.bondfireId })
  const inFeed = async () =>
    (await viewer.query(api.bondfires.listFeed, {})).some((b) => b._id === draft.bondfireId)
  return { ...base, draft, viewer, args, detail, inFeed }
}

describe('shared draft to growing playback', () => {
  it('keeps the shared destination visible before playback, then enters feeds while recording', async () => {
    const { t, owner, fixture, draft, args, detail, inFeed } = await sharedDraft()
    expect((await detail())?.videoStatus).toBe('pending')
    expect(await inFeed()).toBe(false)
    expect(
      await t
        .withIdentity({ subject: fixture.outsider })
        .query(api.bondfires.getWithVideos, { bondfireId: draft.bondfireId }),
    ).toBeNull()
    const recording = await owner.mutation(api.segmentMedia.begin, args)
    expect(recording.recordId).toBe(draft.bondfireId)
    expect((await detail())?.videoStatus).toBe('waiting_for_upload')
    expect((await detail())?.title).toBe('Shared before recording')
    expect(await inFeed()).toBe(false)
    const receipt = (index: number, duration: number) =>
      t.mutation(internal.segmentMedia.receipt, {
        recordingId: recording.recordingId,
        userId: fixture.owner,
        index,
        duration,
        size: 1000,
        checksum: 'b'.repeat(64),
      })
    await receipt(-1, 0)
    await receipt(0, 4)
    expect(await inFeed()).toBe(false)
    await receipt(1, 4)
    expect((await detail())?.videoStatus).toBe('live')
    expect(await inFeed()).toBe(true)
    expect(
      (await owner.query(api.conversations.listMyFires, {})).some(
        (b) => b._id === draft.bondfireId,
      ),
    ).toBe(true)
    await receipt(1, 4)
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: recording.recordingId,
      segmentCount: 2,
    })
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: recording.recordingId,
      segmentCount: 2,
    })
    expect((await detail())?.videoStatus).toBe('ready')
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(scheduled.filter((f) => f.name.includes('notifyCampBondfire'))).toHaveLength(1)
    await t.mutation(internal.personalBondfires.cleanupExpiredDrafts, {})
    expect(await detail()).not.toBeNull()
    await t.mutation(internal.segmentMedia.revoke, { recordingId: recording.recordingId })
    expect((await detail())?.videoStatus).toBe('errored')
    expect(await inFeed()).toBe(false)
  })
  it('publishes a completed short clip and fences a second attempt and discard after attachment', async () => {
    const { t, owner, fixture, draft, args, detail, inFeed } = await sharedDraft()
    const recording = await owner.mutation(api.segmentMedia.begin, args)
    await expect(
      owner.mutation(api.segmentMedia.begin, {
        ...args,
        localId: '00000000-0000-4000-8000-000000000003',
      }),
    ).rejects.toThrow()
    await expect(
      owner.mutation(api.personalBondfires.discardDraftBondfire, { bondfireId: draft.bondfireId }),
    ).rejects.toThrow()
    for (const [index, duration] of [
      [-1, 0],
      [0, 2],
    ])
      await t.mutation(internal.segmentMedia.receipt, {
        recordingId: recording.recordingId,
        userId: fixture.owner,
        index,
        duration,
        size: 1000,
        checksum: 'c'.repeat(64),
      })
    expect(await inFeed()).toBe(false)
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: recording.recordingId,
      segmentCount: 1,
    })
    expect((await detail())?.videoStatus).toBe('ready')
    expect(await inFeed()).toBe(true)
  })
  it('expires an empty draft before the cleanup tick and removes its shared invitation on cleanup', async () => {
    const { t, owner, viewer, draft, args, detail, inFeed } = await sharedDraft()
    await t.run((ctx) => ctx.db.patch(draft.bondfireId, { draftExpiresAt: Date.now() - 1 }))
    expect(await detail()).toBeNull()
    expect(await inFeed()).toBe(false)
    await expect(owner.mutation(api.segmentMedia.begin, args)).rejects.toThrow()
    expect(
      await viewer.mutation(api.personalBondfires.redeemInvite, { code: draft.inviteCode }),
    ).toEqual({ invalid: true })
    await t.mutation(internal.personalBondfires.cleanupExpiredDrafts, {})
    expect(await t.run((ctx) => ctx.db.get(draft.bondfireId))).toBeNull()
  })
})

it('retains a watchable prefix after the upload recovery window instead of deleting it', async () => {
  const { t, record, receipt } = await setup()
  await receipt(-1, 0)
  await receipt(0, 4)
  await receipt(1, 4)
  await t.run((ctx) => ctx.db.patch(record.recordingId, { createdAt: Date.now() - 8 * 86400_000 }))
  const page = await t.query(internal.segmentMedia.cleanupPage, { cursor: null })
  expect(page.ids).not.toContain(record.recordingId)
  expect(page.interrupted).toContain(record.recordingId)
  await t.mutation(internal.segmentMedia.finalizeInterrupted, { recordingId: record.recordingId })
  expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('ready')
  expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.finalCount).toBe(2)
})

describe('indexed media cleanup', () => {
  it('skips ready and recoverable uploads on frequent sweeps but reconciles legacy orphans', async () => {
    const { t, record, fixture } = await setup()
    await t.run(async (ctx) => {
      // More than one page of healthy ready videos must not hide due work.
      for (let i = 0; i < 55; i++)
        await ctx.db.insert('segmentRecordings', {
          userId: fixture.owner,
          localId: `legacy-${i}`,
          status: 'ready',
          segmentCount: 1,
          duration: 4,
          maxDuration: 10,
          createdAt: Date.now() - 8 * 86400_000,
          updatedAt: Date.now(),
          bondfireId: record.recordId as import('./_generated/dataModel').Id<'bondfires'>,
        })
    })
    expect(await t.query(internal.segmentMedia.cleanupPage, { cursor: null })).toEqual({
      ids: [],
      interrupted: [],
      cursor: null,
    })
    await t.run((ctx) => ctx.db.patch(record.recordingId, { status: 'cancelled' }))
    expect(
      await t.query(internal.segmentMedia.cleanupPage, { cursor: null, mode: 'cancelled' }),
    ).toEqual({
      ids: [record.recordingId],
      interrupted: [],
      cursor: null,
    })
    await t.run((ctx) => ctx.db.delete(record.recordId))
    const page = await t.query(internal.segmentMedia.cleanupPage, {
      cursor: null,
      mode: 'reconcile',
    })
    expect(page.ids).toHaveLength(50)
    expect(page.cursor).not.toBeNull()
    const rest = await t.query(internal.segmentMedia.cleanupPage, {
      // Pre-deployment continuations used a full-table cursor without mode.
      cursor: page.cursor,
    })
    expect(rest.ids).toHaveLength(6)
    expect(rest.cursor).toBeNull()
  })

  it.each(['owner deleted', 'owner deleting', 'root expired', 'root deleted'] as const)(
    'reconciles ready recordings when %s',
    async (reason) => {
      const { t, record, fixture } = await setup()
      await t.run(async (ctx) => {
        await ctx.db.patch(record.recordingId, { status: 'ready' })
        if (reason === 'owner deleted') await ctx.db.delete(fixture.owner)
        if (reason === 'owner deleting')
          await ctx.db.patch(fixture.owner, { accountDeletionStatus: 'processing' })
        if (reason === 'root expired')
          await ctx.db.patch(record.recordId, { expiresAt: Date.now() - 1 })
        if (reason === 'root deleted') await ctx.db.delete(record.recordId)
      })
      expect(
        (await t.query(internal.segmentMedia.cleanupPage, { cursor: null, mode: 'reconcile' })).ids,
      ).toContain(record.recordingId)
    },
  )

  it('queues explicit deletion immediately and keeps the original one-hour tombstone', async () => {
    const { t, owner, record } = await setup()
    await owner.mutation(api.bondfires.deleteBondfire, {
      bondfireId: record.recordId as import('./_generated/dataModel').Id<'bondfires'>,
    })
    const cancelled = await t.run((ctx) => ctx.db.get(record.recordingId))
    expect(cancelled?.status).toBe('cancelled')
    await t.mutation(internal.segmentMedia.purge, { recordingId: record.recordingId })
    expect(await t.run((ctx) => ctx.db.get(record.recordingId))).not.toBeNull()
    const originalCancellation = Date.now() - 3600_001
    await t.run(async (ctx) => {
      await ctx.db.patch(record.recordingId, { updatedAt: originalCancellation })
      await cancelSegmentMedia(ctx, { segmentRecordingId: record.recordingId })
    })
    expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.updatedAt).toBe(
      originalCancellation,
    )
    await t.mutation(internal.segmentMedia.purge, { recordingId: record.recordingId })
    expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toBeNull()
  })

  it('deletes abandoned empty uploads only after the recovery window', async () => {
    const { t, record } = await setup()
    expect((await t.query(internal.segmentMedia.cleanupPage, { cursor: null })).ids).toEqual([])
    await t.run((ctx) =>
      ctx.db.patch(record.recordingId, { createdAt: Date.now() - 7 * 86400_000 - 1 }),
    )
    expect((await t.query(internal.segmentMedia.cleanupPage, { cursor: null })).ids).toEqual([
      record.recordingId,
    ])
  })
})
