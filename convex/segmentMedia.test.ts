/// <reference types="vite/client" />

import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import crons from './crons'
import { cancelSegmentMedia } from './lib/segmentMediaCleanup'
import schema from './schema'
import { cleanup } from './segmentMedia'
import * as videos from './videos'

const modules = import.meta.glob('./**/*.ts')
async function setup(maxDurationMs = 10000) {
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
      rules: { access: {}, participation: { maxDurationMs }, advisory: {} },
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
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('begin failure diagnostics', () => {
  it('preserves expected errors without logging them as unexpected failures', async () => {
    const { t, owner, args } = await setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(t.mutation(api.segmentMedia.begin, args)).rejects.toThrow('Sign in required')
    await expect(
      owner.mutation(api.segmentMedia.begin, { ...args, localId: 'invalid' }),
    ).rejects.toThrow('Invalid recording identifier')
    const expected = new ConvexError('This camp is no longer active')
    vi.spyOn(videos, 'createPendingVideoRecord').mockRejectedValueOnce(expected)
    await expect(
      owner.mutation(api.segmentMedia.begin, {
        ...args,
        localId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow('This camp is no longer active')
    expect(log).not.toHaveBeenCalled()
  })

  it('logs the cause and destination, returns a safe error, and rolls back partial writes', async () => {
    const { t, owner, args } = await setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('Unexpected destination failure')
    vi.spyOn(videos, 'createPendingVideoRecord').mockRejectedValueOnce(failure)
    const retryArgs = { ...args, localId: '00000000-0000-4000-8000-000000000002' }
    await expect(owner.mutation(api.segmentMedia.begin, retryArgs)).rejects.toThrow(
      'Could not start this upload. It will retry.',
    )
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[segmentMedia:begin] unexpected error',
      expect.objectContaining({
        localId: retryArgs.localId,
        campId: args.campId,
        isResponse: false,
        message: failure.message,
        stack: failure.stack,
      }),
    )
    const recordings = await t.run((ctx) => ctx.db.query('segmentRecordings').collect())
    expect(recordings).toHaveLength(1)
    expect(recordings[0].localId).toBe(args.localId)
    const recovered = await owner.mutation(api.segmentMedia.begin, retryArgs)
    expect(await owner.mutation(api.segmentMedia.begin, retryArgs)).toEqual(recovered)
  })
})
describe('internal recording lifecycle', () => {
  it('exposes growing duration only to authorized recording viewers', async () => {
    const { t, fixture, record, receipt } = await setup(60000)
    const args = { recordingId: record.recordingId }
    const viewer = t.withIdentity({ subject: fixture.viewer })
    await receipt(-1, 0)
    await receipt(0)
    await receipt(1)
    expect(await viewer.query(api.segmentMedia.playbackDuration, args)).toBe(8)
    await receipt(2)
    expect(await viewer.query(api.segmentMedia.playbackDuration, args)).toBe(12)
    await expect(t.query(api.segmentMedia.playbackDuration, args)).rejects.toThrow()
    await expect(
      t.withIdentity({ subject: fixture.outsider }).query(api.segmentMedia.playbackDuration, args),
    ).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(fixture.members[1]))
    await expect(viewer.query(api.segmentMedia.playbackDuration, args)).rejects.toThrow()
  })

  it.each([
    { isResponse: false, finishEarly: false },
    { isResponse: true, finishEarly: false },
    { isResponse: false, finishEarly: true },
    { isResponse: true, finishEarly: true },
  ])(
    'keeps live parent metadata stable (response=$isResponse, finishEarly=$finishEarly)',
    async ({ isResponse, finishEarly }) => {
      const { t, owner, fixture, args, record: root, receipt: rootReceipt } = await setup(60000)
      if (isResponse) {
        await rootReceipt(-1, 0)
        await rootReceipt(0)
        await owner.mutation(api.segmentMedia.finish, {
          recordingId: root.recordingId,
          segmentCount: 1,
        })
      }
      const record = isResponse
        ? await owner.mutation(api.segmentMedia.begin, {
            ...args,
            localId: '00000000-0000-4000-8000-000000000002',
            isResponse: true,
            bondfireId: root.recordId as import('./_generated/dataModel').Id<'bondfires'>,
          })
        : root
      const receipt = (index: number, documentsWritten?: number) =>
        t.mutation((ctx) =>
          ctx.runMutation(
            internal.segmentMedia.receipt,
            {
              recordingId: record.recordingId,
              userId: fixture.owner,
              index,
              duration: index === -1 ? 0 : 4,
              size: 1000,
              checksum: 'a'.repeat(64),
            },
            { transactionLimits: { documentsWritten } },
          ),
        )
      const finish = (documentsWritten?: number) =>
        owner.mutation((ctx) =>
          ctx.runMutation(
            api.segmentMedia.finish,
            { recordingId: record.recordingId, segmentCount: 10 },
            { transactionLimits: { documentsWritten } },
          ),
        )
      await receipt(-1)
      await receipt(0)
      await receipt(1)
      const live = await t.run((ctx) => ctx.db.get(record.recordId))
      expect(live).toMatchObject({ videoStatus: 'live', durationMs: 8000 })
      expect(live).not.toHaveProperty('recordingStopped')
      const ownerAtLive = await t.run((ctx) => ctx.db.get(fixture.owner))
      const rootAtLive = await t.run((ctx) => ctx.db.get(root.recordId))
      if (isResponse) {
        expect(rootAtLive).toMatchObject({ videoCount: 2 })
        expect(ownerAtLive).toMatchObject({ responseCount: 1 })
      }
      await receipt(-1, 0)
      if (finishEarly) {
        expect(await finish(2)).toEqual({ complete: false })
        await finish(0)
      }
      // A growing receipt may insert its segment and update its recording only.
      // Equal-value parent patches also invalidate subscriptions, so comparing
      // documents alone would not protect the bandwidth optimization.
      for (let index = 2; index < 9; index++) await receipt(index, 2)
      expect(await t.run((ctx) => ctx.db.get(record.recordId))).toEqual(
        finishEarly ? { ...live, recordingStopped: true } : live,
      )
      expect(await t.run((ctx) => ctx.db.get(fixture.owner))).toEqual(ownerAtLive)
      const timeline = await t.query(internal.segmentMedia.timeline, {
        recordingId: record.recordingId,
        userId: fixture.viewer,
        index: null,
      })
      expect(timeline.complete).toBe(false)
      expect(timeline.segments.reduce((sum, segment) => sum + segment.duration, 0)).toBe(36)
      await receipt(9, finishEarly ? undefined : 2)
      if (!finishEarly) expect(await finish()).toEqual({ complete: true })
      const ready = await t.run((ctx) => ctx.db.get(record.recordId))
      const finishedRecording = await t.run((ctx) => ctx.db.get(record.recordingId))
      expect(ready).toMatchObject({ videoStatus: 'ready', durationMs: 40000 })
      await receipt(-1, 0)
      await receipt(9, 0)
      expect(await finish(0)).toEqual({ complete: true })
      expect(await t.run((ctx) => ctx.db.get(record.recordId))).toEqual(ready)
      expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toEqual(finishedRecording)
      expect(await t.run((ctx) => ctx.db.get(fixture.owner))).toEqual(ownerAtLive)
      if (isResponse) expect(await t.run((ctx) => ctx.db.get(root.recordId))).toEqual(rootAtLive)
      const jobs = await t.run((ctx) =>
        ctx.db
          .query('segmentTranscriptionJobs')
          .withIndex('by_recording', (q) => q.eq('recordingId', record.recordingId))
          .collect(),
      )
      expect(jobs).toHaveLength(1)
      const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      expect(
        scheduled.filter((f) =>
          f.name.includes(isResponse ? 'notifyBondfireResponse' : 'notifyCampBondfire'),
        ),
      ).toHaveLength(1)
    },
  )

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

it('serves index playlists from denormalized durations instead of fragment rows', async () => {
  const { t, fixture, record, receipt } = await setup()
  await receipt(-1, 0)
  await receipt(0)
  await receipt(1, 5)
  const page = await t.query(internal.segmentMedia.timeline, {
    recordingId: record.recordingId,
    userId: fixture.owner,
    index: null,
  })
  expect(page.segments).toEqual([
    { index: 0, duration: 4 },
    { index: 1, duration: 5 },
  ])
  expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toMatchObject({
    durations: [4, 5],
  })
  // Legacy row without durations: a query still serves the playlist (reading
  // fragments), while the backfill mutation persists the materialized copy.
  await t.run((ctx) => ctx.db.patch(record.recordingId, { durations: undefined }))
  const legacy = await t.query(internal.segmentMedia.timeline, {
    recordingId: record.recordingId,
    userId: fixture.owner,
    index: null,
  })
  expect(legacy.segments).toEqual(page.segments)
  expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.durations).toBeUndefined()
  await t.mutation(internal.segmentMedia.backfillRecordingDurations, {
    recordingId: record.recordingId,
  })
  expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.durations).toEqual([4, 5])
  const served = await t.query(internal.segmentMedia.timeline, {
    recordingId: record.recordingId,
    userId: fixture.owner,
    index: null,
  })
  expect(served.segments).toEqual(page.segments)
})

it('retains a watchable prefix after the upload recovery window instead of deleting it', async () => {
  const { t, record, receipt } = await setup(60000)
  await receipt(-1, 0)
  await receipt(0, 4)
  await receipt(1, 4)
  await receipt(2, 4)
  expect(await t.run((ctx) => ctx.db.get(record.recordId))).toMatchObject({
    videoStatus: 'live',
    durationMs: 8000,
  })
  await t.run((ctx) => ctx.db.patch(record.recordingId, { createdAt: Date.now() - 8 * 86400_000 }))
  const page = await t.query(internal.segmentMedia.cleanupPage, { cursor: null })
  expect(page.ids).not.toContain(record.recordingId)
  expect(page.interrupted).toContain(record.recordingId)
  await t.mutation(internal.segmentMedia.finalizeInterrupted, { recordingId: record.recordingId })
  expect(await t.run((ctx) => ctx.db.get(record.recordId))).toMatchObject({
    videoStatus: 'ready',
    durationMs: 12000,
  })
  expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.finalCount).toBe(3)
})

describe('indexed media cleanup', () => {
  it('schedules uploading, cancelled retries, and reconciliation independently', () => {
    const jobs = Object.values(crons.crons).filter(
      (job) => job.name === getFunctionName(internal.segmentMedia.cleanup),
    )
    expect(jobs).toEqual([
      {
        name: getFunctionName(internal.segmentMedia.cleanup),
        args: [{}],
        schedule: { type: 'interval', minutes: 5 },
      },
      {
        name: getFunctionName(internal.segmentMedia.cleanup),
        args: [{ mode: 'cancelled' }],
        schedule: { type: 'interval', hours: 1 },
      },
      {
        name: getFunctionName(internal.segmentMedia.cleanup),
        args: [{ mode: 'reconcile' }],
        schedule: { type: 'interval', hours: 24 },
      },
    ])
  })

  it('drains cancelled pages only on their own sweep and retains fresh tombstones until a later retry', async () => {
    vi.useFakeTimers()
    try {
      const { t, fixture, record } = await setup()
      const cancelledAt = Date.now() - 3600_001
      const matureIds = await t.run(async (ctx) => {
        const ids: Id<'segmentRecordings'>[] = []
        for (let i = 0; i < 55; i++)
          ids.push(
            await ctx.db.insert('segmentRecordings', {
              userId: fixture.owner,
              localId: `cancelled-${i}`,
              status: 'cancelled',
              segmentCount: 0,
              duration: 0,
              maxDuration: 10,
              // Both sides of the uploading cutoff must be retried, including
              // recent recordings on the second page of the cancelled index.
              createdAt: Date.now() - (i < 27 ? 8 * 86400_000 : 2 * 3600_000),
              updatedAt: cancelledAt,
            }),
          )
        await ctx.db.patch(record.recordingId, { status: 'cancelled' })
        return ids
      })
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await t.action(internal.segmentMedia.cleanup, {})
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(fetchMock).not.toHaveBeenCalled()

      await t.action(internal.segmentMedia.cleanup, { mode: 'cancelled' })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(fetchMock).toHaveBeenCalledTimes(56)
      expect(await t.run((ctx) => Promise.all(matureIds.map((id) => ctx.db.get(id))))).toEqual(
        matureIds.map(() => null),
      )
      const freshTombstone = await t.run((ctx) => ctx.db.get(record.recordingId))
      expect(freshTombstone?.status).toBe('cancelled')

      vi.advanceTimersByTime(3600_000)
      await t.action(internal.segmentMedia.cleanup, { mode: 'cancelled' })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(fetchMock).toHaveBeenCalledTimes(57)
      expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toBeNull()
      const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      expect(scheduled.every((job) => job.state.kind === 'success')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

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
    expect(
      await t.query((ctx) =>
        ctx.runQuery(
          internal.segmentMedia.cleanupPage,
          { cursor: null },
          { transactionLimits: { documentsRead: 0 } },
        ),
      ),
    ).toEqual({
      ids: [],
      interrupted: [],
      materialize: [],
      cursor: null,
    })
    await t.run((ctx) => ctx.db.patch(record.recordingId, { status: 'cancelled' }))
    expect(
      await t.query(internal.segmentMedia.cleanupPage, { cursor: null, mode: 'cancelled' }),
    ).toEqual({
      ids: [record.recordingId],
      interrupted: [],
      materialize: [],
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
      cursor: page.cursor,
      mode: 'reconcile',
      reconcileStatus: 'ready',
    })
    expect(rest.ids).toHaveLength(5)
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

  it.each([undefined, 'reconcile'] as const)(
    'restarts a legacy full-table continuation (mode=%s) on indexed status pages',
    async (mode) => {
      const { t, record, fixture } = await setup()
      const { cursor, readyId } = await t.run(async (ctx) => {
        // Simulate a cursor queued by either version of the old full scan.
        const oldPage = await ctx.db
          .query('segmentRecordings')
          .paginate({ cursor: null, numItems: 1 })
        const readyId = await ctx.db.insert('segmentRecordings', {
          userId: fixture.owner,
          localId: 'legacy-ready',
          status: 'ready',
          segmentCount: 1,
          duration: 4,
          maxDuration: 10,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        return { cursor: oldPage.continueCursor, readyId }
      })
      expect(await t.query(internal.segmentMedia.cleanupPage, { cursor, mode })).toEqual({
        ids: [readyId],
        interrupted: [],
        materialize: [],
        cursor: null,
      })
      // Recent uploads with missing parents must still be reconciled daily.
      await t.run((ctx) => ctx.db.delete(record.recordId))
      expect(
        await t.query(internal.segmentMedia.cleanupPage, {
          cursor: null,
          mode: 'reconcile',
          reconcileStatus: 'uploading',
        }),
      ).toEqual({ ids: [record.recordingId], interrupted: [], materialize: [], cursor: null })
    },
  )

  it.each([undefined, 'reconcile'] as const)(
    'drains restarted legacy cleanup (mode=%s) through ready and uploading indexes',
    async (mode) => {
      vi.useFakeTimers()
      try {
        const { t, record, fixture } = await setup()
        const readyIds = await t.run(async (ctx) => {
          const ids: Id<'segmentRecordings'>[] = []
          for (let i = 0; i < 55; i++) {
            ids.push(
              await ctx.db.insert('segmentRecordings', {
                userId: fixture.owner,
                localId: `orphan-ready-${i}`,
                status: 'ready',
                segmentCount: 1,
                duration: 4,
                maxDuration: 10,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }),
            )
          }
          await ctx.db.delete(record.recordId)
          return ids
        })
        // A deliberately invalid cursor proves it never reaches pagination.
        await t.action(internal.segmentMedia.cleanup, { cursor: 'legacy-full-table-cursor', mode })
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        await t.finishAllScheduledFunctions(vi.runAllTimers)
        expect(fetchMock).toHaveBeenCalledTimes(56)
        const statuses = await t.run(async (ctx) =>
          Promise.all(
            [...readyIds, record.recordingId].map(async (id) => (await ctx.db.get(id))?.status),
          ),
        )
        expect(statuses.every((status) => status === 'cancelled')).toBe(true)
        const scheduled = await t.run((ctx) =>
          ctx.db.system.query('_scheduled_functions').collect(),
        )
        expect(scheduled.every((job) => job.state.kind === 'success')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
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

it('keeps the uploading index cutoff fixed across delayed cleanup pages', async () => {
  const runQuery = vi.fn(async (_reference: unknown, _args: unknown) => ({
    ids: [],
    interrupted: [],
    materialize: [],
    cursor: 'next-page',
  }))
  const runAfter = vi.fn()
  const ctx = { runQuery, scheduler: { runAfter } } as unknown as ActionCtx
  const handler = (
    cleanup as unknown as {
      _handler: (
        ctx: ActionCtx,
        args: { cursor?: string; mode?: string; cutoff?: number },
      ) => Promise<void>
    }
  )._handler
  await handler(ctx, {})
  const firstArgs = runQuery.mock.calls[0]?.[1] as unknown as { cutoff: number }
  const continuation = runAfter.mock.calls[0]?.[2]
  expect(continuation).toEqual({ cursor: 'next-page', mode: 'uploading', cutoff: firstArgs.cutoff })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  try {
    await handler(ctx, continuation)
    expect(runQuery).toHaveBeenLastCalledWith(internal.segmentMedia.cleanupPage, {
      cursor: 'next-page',
      mode: 'uploading',
      cutoff: firstArgs.cutoff,
    })
    expect(runAfter.mock.calls[1]?.[2]).toEqual(continuation)
  } finally {
    clock.mockRestore()
  }
})

it('paginates more than fifty old uploads without expanding the cutoff between pages', async () => {
  const { t, fixture, record } = await setup()
  const cutoff = Date.now() - 7 * 86400_000
  await t.run(async (ctx) => {
    for (let i = 0; i < 52; i++)
      await ctx.db.insert('segmentRecordings', {
        userId: fixture.owner,
        localId: `old-upload-${i}`,
        bondfireId: record.recordId as import('./_generated/dataModel').Id<'bondfires'>,
        status: 'uploading',
        segmentCount: 0,
        duration: 0,
        maxDuration: 10,
        createdAt: i === 51 ? cutoff + 1 : cutoff - 1,
        updatedAt: Date.now(),
      })
  })
  const first = await t.query(internal.segmentMedia.cleanupPage, {
    cursor: null,
    mode: 'uploading',
    cutoff,
  })
  expect(first.ids).toHaveLength(50)
  expect(first.cursor).not.toBeNull()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  try {
    const rest = await t.query(internal.segmentMedia.cleanupPage, {
      cursor: first.cursor,
      mode: 'uploading',
      cutoff,
    })
    expect(rest.ids).toHaveLength(1)
    expect(rest.cursor).toBeNull()
  } finally {
    clock.mockRestore()
  }
})

describe('independent media cleanup jobs', () => {
  it.each([
    { mode: undefined, cursor: null },
    { mode: undefined, cursor: 'next-page' },
    { mode: 'cancelled' as const, cursor: null },
    { mode: 'cancelled' as const, cursor: 'next-page' },
  ])(
    'dispatches every candidate and the continuation (mode=$mode, cursor=$cursor) before deletion runs',
    async ({ mode, cursor }) => {
      const ids = ['failed-recording', 'healthy-recording'] as Id<'segmentRecordings'>[]
      const interrupted = ['playable-recording'] as Id<'segmentRecordings'>[]
      const runQuery = vi.fn(async () => ({ ids, interrupted, materialize: [], cursor }))
      const runAfter = vi.fn()
      if (!('_handler' in cleanup) || typeof cleanup._handler !== 'function')
        throw new Error('Missing cleanup action handler')
      // No network or mutation API: discovery cannot wait on individual workers.
      await cleanup._handler(
        { runQuery, scheduler: { runAfter } },
        {
          cutoff: 123,
          mode,
          ...(mode === 'cancelled' ? { cursor: 'current-page' } : {}),
        },
      )
      expect(runQuery).toHaveBeenCalledWith(internal.segmentMedia.cleanupPage, {
        cursor: mode === 'cancelled' ? 'current-page' : null,
        mode: mode ?? 'uploading',
        cutoff: 123,
      })
      expect(runAfter).toHaveBeenCalledTimes(cursor ? 4 : 3)
      for (const recordingId of ids)
        expect(runAfter).toHaveBeenCalledWith(0, internal.segmentMedia.cleanupRecording, {
          recordingId,
        })
      expect(runAfter).toHaveBeenCalledWith(0, internal.segmentMedia.finalizeInterrupted, {
        recordingId: interrupted[0],
      })
      if (cursor)
        expect(runAfter).toHaveBeenLastCalledWith(0, internal.segmentMedia.cleanup, {
          cursor,
          mode: mode ?? 'uploading',
          cutoff: 123,
        })
    },
  )

  it.each(['http', 'network'] as const)(
    'keeps a failed %s deletion retryable while another recording is purged',
    async (failure) => {
      const { t, record, fixture } = await setup()
      const cancelledAt = Date.now() - 3600_001
      const otherId = await t.run(async (ctx) => {
        await ctx.db.patch(record.recordingId, { status: 'cancelled', updatedAt: cancelledAt })
        return ctx.db.insert('segmentRecordings', {
          userId: fixture.owner,
          localId: 'other-cancelled',
          status: 'cancelled',
          segmentCount: 0,
          duration: 0,
          maxDuration: 10,
          createdAt: cancelledAt,
          updatedAt: cancelledAt,
        })
      })
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
      if (failure === 'http') fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
      else fetchMock.mockRejectedValueOnce(new Error('network unavailable'))
      vi.stubGlobal('fetch', fetchMock)
      await expect(
        t.action(internal.segmentMedia.cleanupRecording, {
          recordingId: record.recordingId,
        }),
      ).rejects.toThrow()
      await t.action(internal.segmentMedia.cleanupRecording, { recordingId: otherId })
      expect(await t.run((ctx) => ctx.db.get(otherId))).toBeNull()
      expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toMatchObject({
        status: 'cancelled',
        updatedAt: cancelledAt,
      })
      expect(
        (
          await t.query(internal.segmentMedia.cleanupPage, {
            cursor: null,
            mode: 'cancelled',
          })
        ).ids,
      ).toEqual([record.recordingId])
      await t.action(internal.segmentMedia.cleanupRecording, { recordingId: record.recordingId })
      expect(await t.run((ctx) => ctx.db.get(record.recordingId))).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  it('rechecks stale empty-upload candidates before deleting a recovered prefix or completed recording', async () => {
    const { t, owner, record, receipt } = await setup()
    await t.run((ctx) =>
      ctx.db.patch(record.recordingId, { createdAt: Date.now() - 8 * 86400_000 }),
    )
    expect((await t.query(internal.segmentMedia.cleanupPage, { cursor: null })).ids).toEqual([
      record.recordingId,
    ])
    // A receipt already in flight can commit after discovery and before revocation.
    await receipt(-1, 0)
    await receipt(0, 4)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await t.action(internal.segmentMedia.cleanupRecording, { recordingId: record.recordingId })
    expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.status).toBe('uploading')
    expect(
      (await t.query(internal.segmentMedia.cleanupPage, { cursor: null })).interrupted,
    ).toEqual([record.recordingId])
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: record.recordingId,
      segmentCount: 1,
    })
    await t.action(internal.segmentMedia.cleanupRecording, { recordingId: record.recordingId })
    expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.status).toBe('ready')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('revokes access before external deletion and retains a fresh tombstone for late uploads', async () => {
    const { t, fixture, record } = await setup()
    await t.run((ctx) =>
      ctx.db.patch(record.recordingId, { createdAt: Date.now() - 8 * 86400_000 }),
    )
    const fetchMock = vi.fn(async () => {
      await expect(
        t.query(internal.segmentMedia.authorize, {
          recordingId: record.recordingId,
          userId: fixture.owner,
          operation: 'upload',
        }),
      ).rejects.toThrow('Forbidden')
      expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.status).toBe('cancelled')
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await t.action(internal.segmentMedia.cleanupRecording, { recordingId: record.recordingId })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await t.run((ctx) => ctx.db.get(record.recordingId)))?.status).toBe('cancelled')
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('errored')
  })
})
