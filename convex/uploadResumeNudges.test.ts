/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import * as providers from './lib/pushProviders'
import schema from './schema'
import { sendPage } from './uploadResumeNudges'

const modules = import.meta.glob('./**/*.ts')
const NOW = 1_800_000_000_000
const STALLED_AT = NOW - 30 * 60_000
const token = 'upload-owner-fcm-token'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(providers, 'getPushProviderConfig').mockReturnValue({
    apns: null,
    fcm: { projectId: 'test', clientEmail: 'test@example.com', privateKey: 'unused' },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function fixture(options: { response?: boolean; noTokens?: boolean } = {}) {
  const t = convexTest(schema, modules)
  const userId = await t.run((ctx) =>
    ctx.db.insert('users', {
      gender: 'other',
      // Neither recent foreground activity nor reminder opt-out suppresses account pushes.
      lastActiveAt: NOW,
      notificationPrefs: { reminders: false },
    }),
  )
  const registerToken = () =>
    t.run((ctx) =>
      ctx.db.insert('deviceTokens', {
        userId,
        token,
        tokenType: 'fcm',
        platform: 'android',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
  if (!options.noTokens) await registerToken()
  const addRecording = async (patch: Partial<Doc<'segmentRecordings'>> = {}) =>
    t.run(async (ctx) => {
      const bondfireId = await ctx.db.insert('bondfires', {
        userId,
        videoCount: 0,
        createdAt: STALLED_AT,
        updatedAt: STALLED_AT,
      })
      const responseId = options.response
        ? await ctx.db.insert('bondfireVideos', {
            userId,
            bondfireId,
            sequenceNumber: 1,
            createdAt: STALLED_AT,
          })
        : undefined
      const recordingId = await ctx.db.insert('segmentRecordings', {
        userId,
        localId: `local-${bondfireId}`,
        bondfireId: responseId ? undefined : bondfireId,
        responseId,
        status: 'uploading',
        segmentCount: 0,
        duration: 0,
        maxDuration: 60,
        createdAt: STALLED_AT,
        updatedAt: STALLED_AT,
        ...patch,
      })
      await ctx.db.patch(responseId ?? bondfireId, { segmentRecordingId: recordingId })
      return { bondfireId, responseId, recordingId }
    })
  const recording = await addRecording()
  const send = vi.spyOn(providers, 'sendFcmPushNotification').mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    invalidTokens: [],
    tokenResults: [{ token, outcome: 'success' }],
  })
  const sweep = async () => {
    await t.mutation(internal.uploadResumeNudges.startSweep, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }
  const deliveries = () => t.run((ctx) => ctx.db.query('notificationDeliveries').collect())
  const run = () => t.run((ctx) => ctx.db.query('maintenanceJobRuns').unique())
  return { t, userId, ...recording, addRecording, registerToken, send, sweep, deliveries, run }
}

describe('upload resume delivery', () => {
  it.each([false, true])('sends a stalled recording once (response: %s)', async (response) => {
    const f = await fixture({ response })
    await f.sweep()
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      [token],
      expect.objectContaining({
        title: 'Upload paused',
        body: 'Open so that your recording gets sent.',
        channelId: 'bondfires-default',
        threadId: 'bondfires-account',
        data: {
          type: 'upload-resume',
          bondfireId: f.bondfireId,
          bondfireVideoId: f.responseId,
          recordingId: f.recordingId,
        },
      }),
      expect.any(Object),
    )
    expect(await f.deliveries()).toEqual([
      expect.objectContaining({
        userId: f.userId,
        videoKey: `upload-resume:${f.recordingId}`,
        threadKey: 'upload-resume',
      }),
    ])
    await f.sweep()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.deliveries()).toHaveLength(1)
  })

  it('records no device tokens once, even if a token appears later', async () => {
    const f = await fixture({ noTokens: true })
    await f.sweep()
    expect(await f.deliveries()).toHaveLength(1)
    await f.registerToken()
    await f.sweep()
    expect(f.send).not.toHaveBeenCalled()
    expect(await f.deliveries()).toHaveLength(1)
  })

  it('records only after success and retries a provider failure on the next sweep', async () => {
    const f = await fixture()
    f.send.mockImplementationOnce(async () => {
      expect(await f.deliveries()).toHaveLength(0)
      return {
        successCount: 0,
        failureCount: 1,
        invalidTokens: [],
        tokenResults: [{ token, outcome: 'other_failure' }],
        error: 'Provider unavailable',
      }
    })
    await f.sweep()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.deliveries()).toHaveLength(0)
    await f.sweep()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(await f.deliveries()).toHaveLength(1)
  })

  it('does not record an in-flight send as delivered', async () => {
    const f = await fixture()
    f.send.mockImplementationOnce(async () => {
      expect(await f.deliveries()).toHaveLength(0)
      return {
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
        tokenResults: [{ token, outcome: 'success' }],
      }
    })
    await f.sweep()
    expect(await f.deliveries()).toHaveLength(1)
  })

  it('continues the page after a send action throws and retries on the next sweep', async () => {
    const f = await fixture()
    await f.addRecording()
    await f.t.mutation(internal.uploadResumeNudges.startSweep, {})
    const run = await f.run()
    if (!run) throw new Error('Missing sweep')
    const error = new Error('Push action unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runAction = vi.fn(f.t.action).mockRejectedValueOnce(error)
    // Inject an action-level failure, outside sendToUser's provider error handling.
    const action = sendPage as unknown as {
      _handler: (ctx: ActionCtx, args: { runId: string }) => Promise<void>
    }
    await action._handler(
      { runQuery: f.t.query, runMutation: f.t.mutation, runAction } as unknown as ActionCtx,
      { runId: run.runId },
    )
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(runAction).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalled()
    expect(await f.deliveries()).toHaveLength(1)
    expect(await f.run()).toMatchObject({ status: 'complete' })
    await f.sweep()
    expect(await f.deliveries()).toHaveLength(2)
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('purges reminder metadata with its recording and rejects a late delivery write', async () => {
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://lovely-malamute-525.convex.cloud')
    vi.stubEnv('INTERNAL_SEGMENT_MEDIA', '1')
    const f = await fixture()
    await f.sweep()
    await f.t.run((ctx) =>
      ctx.db.patch(f.recordingId, { status: 'cancelled', updatedAt: NOW - 3600_000 }),
    )
    await f.t.mutation(internal.segmentMedia.purge, { recordingId: f.recordingId })
    expect(await f.t.run((ctx) => ctx.db.get(f.recordingId))).toBeNull()
    expect(await f.deliveries()).toHaveLength(0)
    await f.t.mutation(internal.uploadResumeNudges.recordDelivery, {
      recordingId: f.recordingId,
      userId: f.userId,
    })
    expect(await f.deliveries()).toHaveLength(0)
  })

  it.each(['cancelled', 'deleting owner', 'deleted owner'])(
    'does not create delivery metadata after %s during a send',
    async (reason) => {
      const f = await fixture()
      f.send.mockImplementationOnce(async () => {
        await f.t.run(async (ctx) => {
          if (reason === 'cancelled') await ctx.db.patch(f.recordingId, { status: 'cancelled' })
          if (reason === 'deleting owner')
            await ctx.db.patch(f.userId, { accountDeletionStatus: 'requested' })
          if (reason === 'deleted owner') await ctx.db.delete(f.userId)
        })
        return {
          successCount: 1,
          failureCount: 0,
          invalidTokens: [],
          tokenResults: [{ token, outcome: 'success' }],
        }
      })
      await f.sweep()
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(await f.deliveries()).toHaveLength(0)
    },
  )
})

describe('upload resume eligibility', () => {
  it.each([
    ['recent receipt', { updatedAt: STALLED_AT + 1 }],
    ['ready status', { status: 'ready' }],
    ['cancelled status', { status: 'cancelled' }],
    ['complete timeline', { finalCount: 2, segmentCount: 2, initChecksum: 'init' }],
  ] satisfies [string, Partial<Doc<'segmentRecordings'>>][])('skips %s', async (_name, patch) => {
    const f = await fixture()
    await f.t.run((ctx) => ctx.db.patch(f.recordingId, patch))
    await f.sweep()
    expect(f.send).not.toHaveBeenCalled()
    expect(await f.deliveries()).toHaveLength(0)
  })

  it.each(['unlinked', 'expired', 'deleting', 'missing owner', 'missing source'])(
    'skips a recording with %s destination/owner',
    async (reason) => {
      const f = await fixture()
      await f.t.run(async (ctx) => {
        if (reason === 'unlinked')
          await ctx.db.patch(f.bondfireId, { segmentRecordingId: undefined })
        if (reason === 'expired') await ctx.db.patch(f.bondfireId, { expiresAt: NOW })
        if (reason === 'deleting')
          await ctx.db.patch(f.userId, { accountDeletionStatus: 'requested' })
        if (reason === 'missing owner') await ctx.db.delete(f.userId)
        if (reason === 'missing source') await ctx.db.delete(f.bondfireId)
      })
      await f.sweep()
      expect(f.send).not.toHaveBeenCalled()
    },
  )

  it.each(['unlinked', 'missing', 'expired source'])('skips a response with %s', async (reason) => {
    const f = await fixture({ response: true })
    const responseId = f.responseId
    if (!responseId) throw new Error('Missing response fixture')
    await f.t.run(async (ctx) => {
      if (reason === 'unlinked') await ctx.db.patch(responseId, { segmentRecordingId: undefined })
      if (reason === 'missing') await ctx.db.delete(responseId)
      if (reason === 'expired source') await ctx.db.patch(f.bondfireId, { expiresAt: NOW })
    })
    await f.sweep()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    ['missing tail', { finalCount: 3, segmentCount: 2, initChecksum: 'init' }],
    ['missing init', { finalCount: 2, segmentCount: 2 }],
    ['empty upload', { segmentCount: 0 }],
    ['legacy stalled row', { createdAt: NOW - 8 * 86_400_000, updatedAt: NOW - 86_400_000 }],
  ] satisfies [string, Partial<Doc<'segmentRecordings'>>][])(
    'sends for %s',
    async (_name, patch) => {
      const f = await fixture()
      await f.t.run(async (ctx) => {
        await ctx.db.patch(f.recordingId, patch)
        await ctx.db.patch(f.bondfireId, { expiresAt: NOW + 60_000 })
      })
      await f.sweep()
      expect(f.send).toHaveBeenCalledTimes(1)
    },
  )

  it('rechecks a receipt arriving after the page was claimed', async () => {
    const f = await fixture()
    await f.t.mutation(internal.uploadResumeNudges.startSweep, {})
    const run = await f.run()
    if (!run) throw new Error('Missing sweep')
    const args = { runId: run.runId }
    expect(await f.t.mutation(internal.uploadResumeNudges.claimPage, args)).toMatchObject({
      recordingIds: [f.recordingId],
    })
    await f.t.run((ctx) => ctx.db.patch(f.recordingId, { updatedAt: NOW }))
    expect(
      await f.t.query(internal.uploadResumeNudges.getCandidate, {
        ...args,
        recordingId: f.recordingId,
      }),
    ).toBeNull()
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('upload resume sweep leases', () => {
  it('excludes new uploads from the indexed scan using the sweep start time', async () => {
    const f = await fixture()
    for (let i = 0; i < 25; i++) await f.addRecording({ createdAt: NOW, updatedAt: NOW })
    await f.t.mutation(internal.uploadResumeNudges.startSweep, {})
    vi.setSystemTime(NOW + 30 * 60_000)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.run()).toMatchObject({ status: 'complete', pagesProcessed: 1 })
    await f.sweep()
    expect(f.send).toHaveBeenCalledTimes(26)
  })

  it('rejects overlapping cron ticks and duplicate page actions', async () => {
    const f = await fixture()
    expect(await f.t.mutation(internal.uploadResumeNudges.startSweep, {})).toBe(true)
    expect(await f.t.mutation(internal.uploadResumeNudges.startSweep, {})).toBe(false)
    const run = await f.run()
    if (!run) throw new Error('Missing sweep')
    await Promise.all([
      f.t.action(internal.uploadResumeNudges.sendPage, { runId: run.runId }),
      f.t.action(internal.uploadResumeNudges.sendPage, { runId: run.runId }),
    ])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.run()).toMatchObject({ status: 'complete', pagesProcessed: 1 })
  })

  it('continues past a full ineligible page and completes the sweep', async () => {
    const f = await fixture()
    await f.t.run((ctx) => ctx.db.patch(f.recordingId, { updatedAt: NOW }))
    for (let i = 0; i < 24; i++) await f.addRecording({ updatedAt: NOW })
    const last = await f.addRecording()
    await f.sweep()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.deliveries()).toEqual([
      expect.objectContaining({ videoKey: `upload-resume:${last.recordingId}` }),
    ])
    expect(await f.run()).toMatchObject({ status: 'complete', pagesProcessed: 2 })
  })

  it('recovers an abandoned lease and fences out the old page', async () => {
    const f = await fixture()
    await f.t.mutation(internal.uploadResumeNudges.startSweep, {})
    const oldRun = await f.run()
    if (!oldRun) throw new Error('Missing sweep')
    await f.t.mutation(internal.uploadResumeNudges.claimPage, { runId: oldRun.runId })
    vi.setSystemTime(NOW + 15 * 60_000 + 1)
    expect(await f.t.mutation(internal.uploadResumeNudges.startSweep, {})).toBe(true)
    await f.t.action(internal.uploadResumeNudges.sendPage, { runId: oldRun.runId })
    expect(f.send).not.toHaveBeenCalled()
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.run()).toMatchObject({ status: 'complete', pagesProcessed: 1 })
  })
})
