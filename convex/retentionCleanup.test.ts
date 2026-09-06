import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx } from './_generated/server'
import { saveTranscript } from './ai'
import {
  canExpireBondfire,
  canExpireCamp,
  enforceBondfireRetention,
  previewPage,
  scanPage,
} from './bondfireRetention'
import { dailyCleanupArchivedCamps } from './cleanup'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import { claimUserDeliveries } from './digest'
import { BONDFIRE_RETENTION_MS } from './entitlements'
import { claimBondfire, resumeStale, retainedVideoExists, runBatch } from './retentionCleanup'
import {
  claimBatch,
  deleteRetentionResource,
  drain,
  enqueueUnlinked,
  finishAttempt,
  rememberAssets,
} from './retentionMedia'
import { claimDeliveries } from './sendNotification'
import { createPendingMuxVideo } from './videos'

type Row = Record<string, unknown> & { _id: string }
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected test fixture')
  return value
}
function handler<T>(fn: unknown) {
  return (fn as { _handler: (ctx: T, args: Record<string, unknown>) => Promise<unknown> })._handler
}

// Handler-level tests use the same in-memory pattern as billing integration
// tests. This harness deliberately tracks query bounds and preserves cursors
// across deletions; Convex itself provides transaction rollback/OCC in production.
describe('retention transactions and resumable cleanup', () => {
  let tables: Record<string, Row[]>
  let scheduled: Array<{ name: string; args: Record<string, unknown> }>
  let ctx: MutationCtx
  let takeSizes: number[]
  let nextId: number
  let metadataPageSize: number
  const now = 2_000_000_000_000
  const old = now - BONDFIRE_RETENTION_MS - 1
  const userId = 'users_owner' as Id<'users'>
  const rootId = 'bondfires_0001' as Id<'bondfires'>
  const responseId = 'bondfireVideos_0001' as Id<'bondfireVideos'>
  const root = () => tables.bondfires[0] as unknown as Doc<'bondfires'>
  const put = (table: string, row: Row) => {
    tables[table] ??= []
    tables[table].push(row)
  }
  const get = async (id: string) =>
    Object.values(tables)
      .flat()
      .find((row) => row._id === id) ?? null
  const functions: Record<string, unknown> = {
    'retentionCleanup:runBatch': runBatch,
    'bondfireRetention:scanPage': scanPage,
    'retentionMedia:claimBatch': claimBatch,
    'retentionMedia:finishAttempt': finishAttempt,
    'retentionMedia:rememberAssets': rememberAssets,
  }
  async function runDatabaseQueue() {
    for (let i = 0; scheduled.length && i < 10_000; i++) {
      const task = required(scheduled.shift())
      if (task.name === 'retentionMedia:drain') continue // Never contact real Mux.
      expect(functions[task.name], task.name).toBeDefined()
      await handler<MutationCtx>(functions[task.name])(ctx, task.args)
    }
    expect(scheduled).toHaveLength(0)
  }
  async function claimSweep() {
    await handler<MutationCtx>(enforceBondfireRetention)(ctx, {})
    const task = required(scheduled.shift())
    await handler<MutationCtx>(scanPage)(ctx, task.args)
    return task
  }

  beforeEach(() => {
    vi.stubEnv('RETENTION_CLAIMS_ENABLED', 'true')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected external request')
      }),
    )
    tables = { users: [], bondfires: [], bondfireVideos: [], subscriptions: [] }
    scheduled = []
    takeSizes = []
    nextId = 0
    metadataPageSize = 25
    put('users', {
      _id: userId,
      bondfireCount: 1,
      responseCount: 1,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    })
    put('bondfires', {
      _id: rootId,
      userId,
      createdAt: old,
      updatedAt: old,
      videoStatus: 'ready',
      muxAssetId: 'root-asset',
      videoCount: 2,
    })
    put('bondfireVideos', {
      _id: responseId,
      bondfireId: rootId,
      userId,
      createdAt: old,
      videoStatus: 'ready',
      muxAssetId: 'response-asset',
      countedAt: old,
      sequenceNumber: 1,
    })
    ctx = {
      db: {
        get,
        normalizeId: (table: string, id: string) => (id.startsWith(`${table}_`) ? id : null),
        insert: async (table: string, value: Record<string, unknown>) => {
          const id = `${table}_new${String(++nextId).padStart(5, '0')}`
          put(table, { ...value, _id: id })
          return id
        },
        patch: async (id: string, fields: Record<string, unknown>) => {
          const row = await get(id)
          if (!row) throw new Error(`Missing patch target ${id}`)
          Object.assign(row, fields)
        },
        delete: async (id: string) => {
          for (const table of Object.keys(tables))
            tables[table] = tables[table].filter((row) => row._id !== id)
        },
        query: (table: string) => {
          let rows = [...(tables[table] ?? [])]
          let sortField = '_id'
          const range = {
            eq: (field: string, value: unknown) => {
              rows = rows.filter((row) => row[field] === value)
              return range
            },
            lt: (field: string, value: number) => {
              rows = rows.filter((row) => (row[field] as number) < value)
              return range
            },
            lte: (field: string, value: number) => {
              rows = rows.filter((row) => (row[field] as number) <= value)
              return range
            },
          }
          const query = {
            withIndex: (index: string, filter?: (q: typeof range) => unknown) => {
              filter?.(range)
              sortField =
                index === 'by_bondfire_created' || index === 'by_created'
                  ? 'createdAt'
                  : index === 'by_next_attempt'
                    ? 'nextAttemptAt'
                    : '_id'
              rows.sort((a, b) =>
                (a[sortField] as number | string) < (b[sortField] as number | string)
                  ? -1
                  : (a[sortField] as number | string) > (b[sortField] as number | string)
                    ? 1
                    : a._id.localeCompare(b._id),
              )
              return query
            },
            order: (direction: string) => {
              if (direction === 'desc') rows.reverse()
              return query
            },
            first: async () => rows[0] ?? null,
            take: async (size: number) => {
              takeSizes.push(size)
              return rows.slice(0, size)
            },
            collect: async () => {
              expect(table).toBe('subscriptions')
              expect(rows.length).toBeLessThanOrEqual(100)
              return rows
            },
            paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
              expect(numItems).toBeLessThanOrEqual(25)
              const remaining = cursor ? rows.filter((row) => row._id > cursor) : rows
              const size = table === 'watchEvents' ? Math.min(metadataPageSize, numItems) : numItems
              const page = remaining.slice(0, size)
              return {
                page,
                continueCursor: page.at(-1)?._id ?? cursor ?? '',
                isDone: remaining.length <= size,
              }
            },
          }
          return query
        },
      },
      scheduler: {
        runAfter: async (
          _delay: number,
          fn: Parameters<typeof getFunctionName>[0],
          args: Record<string, unknown>,
        ) => {
          scheduled.push({ name: getFunctionName(fn), args })
          return 'scheduled'
        },
      },
      storage: { delete: vi.fn() },
      runMutation: async (
        fn: Parameters<typeof getFunctionName>[0],
        args: Record<string, unknown>,
      ) => handler<MutationCtx>(functions[getFunctionName(fn)])(ctx, args),
    } as unknown as MutationCtx
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('claims the root and its media atomically, before any external delete; retries do not double-count', async () => {
    const task = await claimSweep()
    expect(await get(rootId)).toBeNull()
    expect(tables.retentionCleanupJobs).toHaveLength(1)
    expect(tables.retentionMedia).toEqual([
      expect.objectContaining({ kind: 'asset', externalId: 'root-asset' }),
    ])
    expect(fetch).not.toHaveBeenCalled()
    await handler<MutationCtx>(scanPage)(ctx, task.args)
    expect(tables.users[0].bondfireCount).toBe(0)
    await expect(
      handler<MutationCtx>(createPendingMuxVideo)(ctx, {
        userId,
        isResponse: true,
        bondfireId: rootId,
        uploadId: 'late-upload',
        playbackPolicy: 'public',
      }),
    ).rejects.toThrow(/Bondfire not found/)
    expect(await retainedVideoExists(ctx, responseId)).toBe(false)
  })

  it('offers a read-only preview without claiming records or scheduling work', async () => {
    vi.stubEnv('RETENTION_CLAIMS_ENABLED', 'false')
    await handler<MutationCtx>(enforceBondfireRetention)(ctx, {})
    expect(await handler<MutationCtx>(previewPage)(ctx, { kind: 'bondfire' })).toMatchObject({
      eligibleIds: [rootId],
      scanned: 1,
      isDone: true,
    })
    expect(await get(rootId)).not.toBeNull()
    expect(scheduled).toHaveLength(0)
    expect(tables.retentionMedia ?? []).toHaveLength(0)
  })

  it('pauses an in-flight scan without losing its cursor, but finishes already claimed cleanup', async () => {
    await claimSweep()
    vi.stubEnv('RETENTION_CLAIMS_ENABLED', 'false')
    await runDatabaseQueue()
    expect(tables.retentionCleanupJobs).toHaveLength(0)
    expect(tables.bondfireVideos).toHaveLength(0)
    vi.stubEnv('RETENTION_CLAIMS_ENABLED', 'true')
    await handler<MutationCtx>(enforceBondfireRetention)(ctx, {})
    const task = required(scheduled.shift())
    const before = { ...tables.maintenanceJobRuns[0] }
    vi.stubEnv('RETENTION_CLAIMS_ENABLED', 'false')
    await handler<MutationCtx>(scanPage)(ctx, task.args)
    expect(tables.maintenanceJobRuns[0]).toEqual(before)
  })

  it('does not skip cleanup when byte limits return a short metadata page', async () => {
    metadataPageSize = 3
    for (let i = 0; i < 40; i++) put('watchEvents', { _id: `watchEvents_${i}`, videoId: rootId })
    await claimSweep()
    await runDatabaseQueue()
    expect(tables.watchEvents).toHaveLength(0)
  })

  it('decrements a legacy ready response without a countedAt marker exactly once', async () => {
    tables.bondfireVideos[0].countedAt = undefined
    tables.bondfireVideos[0].muxPlaybackId = 'legacy-playback'
    await claimSweep()
    await runDatabaseQueue()
    expect(tables.users[0].responseCount).toBe(0)
    await handler<MutationCtx>(resumeStale)(ctx, {})
    await runDatabaseQueue()
    expect(tables.users[0].responseCount).toBe(0)
  })

  it('preserves legitimate delayed writes while the parent still exists', async () => {
    expect(
      await handler<MutationCtx>(claimDeliveries)(ctx, {
        userIds: [userId],
        videoKey: responseId,
        threadKey: `${rootId}:resp`,
      }),
    ).toEqual([userId])
    expect(
      await handler<MutationCtx>(claimUserDeliveries)(ctx, {
        userId,
        videoKeys: [`digest:${responseId}`],
        threadKey: 'digest',
      }),
    ).toEqual([`digest:${responseId}`])
    expect(
      await handler<MutationCtx>(saveTranscript)(ctx, {
        table: 'bondfireVideos',
        recordId: responseId,
        muxAssetId: 'response-asset',
        text: 'current',
      }),
    ).toEqual(expect.any(String))
    expect(tables.videoTranscripts).toHaveLength(1)
    expect(
      await handler<MutationCtx>(saveTranscript)(ctx, {
        table: 'bondfireVideos',
        recordId: responseId,
        muxAssetId: 'old-asset',
        text: 'stale',
      }),
    ).toBeNull()
    expect(tables.videoTranscripts[0].text).toBe('current')
  })

  it.each(['reply', 'upgrade', 'live', 'upload', 'root_live_session'])(
    'rechecks %s at the claim, not at a prior candidate read',
    async (change) => {
      expect(await canExpireBondfire(ctx, root(), now)).toBe(true)
      if (change === 'reply') tables.bondfireVideos[0].createdAt = now
      if (change === 'upgrade')
        put('subscriptions', {
          _id: 'subscriptions_paid',
          userId,
          tier: 'premium',
          status: 'active',
          verificationStatus: 'verified',
          currentPeriodEnd: now + 1000,
        })
      if (change === 'live') tables.bondfireVideos[0].videoStatus = 'live'
      if (change === 'upload') tables.bondfires[0].videoStatus = 'waiting_for_upload'
      if (change === 'root_live_session') {
        tables.bondfires[0].liveSessionId = 'liveSessions_1'
        put('liveSessions', { _id: 'liveSessions_1', status: 'starting' })
      }
      await claimSweep()
      expect(await get(rootId)).not.toBeNull()
      expect(tables.retentionMedia ?? []).toHaveLength(0)
    },
  )

  it.each(['pending', 'waiting_for_upload', 'processing', 'live', 'awaiting_recovery'])(
    'preserves threads with a %s response, regardless of age',
    async (videoStatus) => {
      tables.bondfireVideos[0].videoStatus = videoStatus
      expect(await canExpireBondfire(ctx, root(), now)).toBe(false)
    },
  )

  it('preserves exact cutoff activity, forced Premium/Pro, and ambiguous oversized subscription histories', async () => {
    tables.bondfireVideos[0].createdAt = now - BONDFIRE_RETENTION_MS
    expect(await canExpireBondfire(ctx, root(), now)).toBe(false)
    tables.bondfireVideos[0].createdAt = old
    for (const forcedTier of ['premium', 'pro']) {
      tables.users[0].forcedTier = forcedTier
      expect(await canExpireBondfire(ctx, root(), now)).toBe(false)
    }
    tables.users[0].forcedTier = undefined
    for (let i = 0; i < 101; i++) put('subscriptions', { _id: `subscriptions_${i}`, userId })
    expect(await canExpireBondfire(ctx, root(), now)).toBe(false)
    expect(Math.max(...takeSizes)).toBe(101)
  })

  it('continues beyond skipped first pages and across deleted rows without rescanning from the beginning', async () => {
    tables.bondfires = []
    for (let i = 0; i < 60; i++)
      put('bondfires', {
        _id: `bondfires_${String(i).padStart(4, '0')}`,
        userId,
        createdAt: old,
        videoStatus: i < 26 ? 'live' : 'ready',
        videoCount: 1,
      })
    await handler<MutationCtx>(enforceBondfireRetention)(ctx, {})
    await runDatabaseQueue()
    expect(tables.bondfires).toHaveLength(26)
    expect(tables.maintenanceJobRuns[0]).toMatchObject({
      status: 'complete',
      pagesProcessed: 3,
      stats: { scanned: 60, claimed: 34 },
    })
  })

  it('resumes large child and metadata collections; inventories the latest child asset and all live resources', async () => {
    for (let i = 0; i < 70; i++) {
      put('watchEvents', { _id: `watchEvents_${i}`, videoId: responseId })
      put('reports', { _id: `reports_${i}`, bondfireId: rootId, bondfireVideoId: responseId })
    }
    for (const parentType of ['bondfire', 'personal-bondfire', 'family-connection']) {
      put('inviteCodes', { _id: `inviteCodes_${parentType}`, parentId: rootId, parentType })
    }
    for (const [videoKey, threadKey] of [
      [`digest:${responseId}`, 'digest'],
      [`nudge:${rootId}`, 'nudge'],
      [responseId, `${rootId}:resp`],
    ]) {
      put('notificationDeliveries', {
        _id: `notificationDeliveries_${videoKey}`,
        videoKey,
        threadKey,
      })
    }
    put('liveSessions', {
      _id: 'liveSessions_old',
      muxLiveStreamId: 'stream',
      muxRecordedAssetId: 'recorded',
      muxRecentAssetId: 'recent',
      muxActiveAssetId: 'active',
      status: 'ended',
    })
    await claimSweep()
    // A callback wins before the child is removed. Its final media pointers
    // must be inventoried, not compared with an old action snapshot.
    Object.assign(tables.bondfireVideos[0], {
      muxAssetId: 'late-asset',
      muxUploadId: 'upload',
      liveSessionId: 'liveSessions_old',
    })
    await runDatabaseQueue()
    for (const table of [
      'bondfireVideos',
      'watchEvents',
      'reports',
      'inviteCodes',
      'notificationDeliveries',
      'liveSessions',
      'retentionCleanupJobs',
    ])
      expect(tables[table] ?? []).toHaveLength(0)
    expect(tables.retentionMedia.map((row) => row.externalId)).toEqual(
      expect.arrayContaining([
        'root-asset',
        'late-asset',
        'upload',
        'stream',
        'recorded',
        'recent',
        'active',
      ]),
    )
    expect(tables.users[0].responseCount).toBe(0)
    expect(takeSizes.every((size) => size <= 25 || size === 101)).toBe(true)
  })

  it('recovers a lost scheduler delivery and ignores stale cleanup revisions', async () => {
    await claimSweep()
    const lost = required(scheduled.shift())
    const job = tables.retentionCleanupJobs[0]
    job.updatedAt = now - 600_000
    await handler<MutationCtx>(resumeStale)(ctx, {})
    await handler<MutationCtx>(runBatch)(ctx, lost.args)
    const revision = job.revision
    await handler<MutationCtx>(runBatch)(ctx, lost.args)
    expect(job.revision).toBe(revision)
    await runDatabaseQueue()
    expect(tables.retentionCleanupJobs).toHaveLength(0)
  })

  it('rechecks archived Camp revival, launch protection, and the deadline before claiming', async () => {
    const camp = { _id: 'camps_old', status: 'archived', archivedAt: old } as Doc<'camps'>
    expect(canExpireCamp(camp, now)).toBe(true)
    expect(canExpireCamp({ ...camp, isLaunchCamp: true }, now)).toBe(false)
    expect(canExpireCamp({ ...camp, status: 'active' }, now)).toBe(false)
    expect(canExpireCamp({ ...camp, archivedAt: now }, now)).toBe(false)
    put('camps', { ...camp })
    await handler<MutationCtx>(dailyCleanupArchivedCamps)(ctx, {})
    tables.camps[0].status = 'active'
    await runDatabaseQueue()
    expect(tables.camps).toHaveLength(1)
  })

  it('claims archived Camps then cascades through threads, memberships, claims and invites; preserves the billing ledger', async () => {
    const campId = 'camps_old'
    put('camps', {
      _id: campId,
      status: 'archived',
      archivedAt: old,
      coverImageStorageId: '_storage_cover',
    })
    tables.bondfires[0].campId = campId
    put('campMembers', { _id: 'campMembers_1', campId })
    put('inviteClaims', { _id: 'inviteClaims_1', campId })
    put('inviteCodes', { _id: 'inviteCodes_1', parentId: campId, parentType: 'camp' })
    put('campSlotTransactions', { _id: 'campSlotTransactions_1', campId })
    await handler<MutationCtx>(dailyCleanupArchivedCamps)(ctx, {})
    await runDatabaseQueue()
    for (const table of [
      'camps',
      'bondfires',
      'bondfireVideos',
      'campMembers',
      'inviteClaims',
      'inviteCodes',
      'retentionCleanupJobs',
    ])
      expect(tables[table]).toHaveLength(0)
    expect(tables.campSlotTransactions).toHaveLength(1)
    expect(ctx.storage.delete).toHaveBeenCalledWith('_storage_cover')
  })

  it('rejects delayed transcript and delivery writes after a claim', async () => {
    await claimBondfire(ctx, root())
    expect(
      await handler<MutationCtx>(saveTranscript)(ctx, {
        table: 'bondfires',
        recordId: rootId,
        muxAssetId: 'root-asset',
        text: 'late',
      }),
    ).toBeNull()
    expect(
      await handler<MutationCtx>(saveTranscript)(ctx, {
        table: 'bondfireVideos',
        recordId: responseId,
        muxAssetId: 'response-asset',
        text: 'late',
      }),
    ).toBeNull()
    expect(
      await handler<MutationCtx>(claimDeliveries)(ctx, {
        userIds: [userId],
        videoKey: responseId,
        threadKey: `${rootId}:resp`,
      }),
    ).toEqual([])
    expect(
      await handler<MutationCtx>(claimUserDeliveries)(ctx, {
        userId,
        videoKeys: [`digest:${responseId}`, `nudge:${rootId}`],
        threadKey: 'digest',
      }),
    ).toEqual([])
    expect(tables.videoTranscripts ?? []).toHaveLength(0)
    expect(tables.notificationDeliveries ?? []).toHaveLength(0)
  })

  it('keeps failed media retryable and fences stale attempts; referenced resources are never claimed', async () => {
    await claimSweep()
    await handler<MutationCtx>(enqueueUnlinked)(ctx, {
      kind: 'direct_upload',
      externalId: 'attached-upload',
    })
    tables.bondfireVideos[0].muxUploadId = 'attached-upload'
    const rows = (await handler<MutationCtx>(claimBatch)(ctx, {})) as Doc<'retentionMedia'>[]
    expect(rows.map((row) => row.externalId)).toEqual(['root-asset'])
    const row = rows[0]
    await handler<MutationCtx>(finishAttempt)(ctx, {
      mediaId: row._id,
      attempt: row.attempts,
      error: '503',
    })
    expect(await get(row._id)).toMatchObject({ lastError: '503' })
    Object.assign(required(await get(row._id)), { nextAttemptAt: now })
    const retried = (await handler<MutationCtx>(claimBatch)(ctx, {})) as Doc<'retentionMedia'>[]
    await handler<MutationCtx>(finishAttempt)(ctx, { mediaId: row._id, attempt: row.attempts })
    expect(await get(row._id)).not.toBeNull()
    await handler<MutationCtx>(finishAttempt)(ctx, {
      mediaId: row._id,
      attempt: retried[0].attempts,
    })
    expect(await get(row._id)).toBeNull()
  })

  it('keeps the outbox through an external outage, then accepts a missing asset on retry', async () => {
    await claimSweep()
    vi.stubEnv('MUX_TOKEN_ID', 'test')
    vi.stubEnv('MUX_TOKEN_SECRET', 'test')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await handler<ActionCtx>(drain)(ctx as unknown as ActionCtx, {})).toEqual({
      processed: 1,
      failed: 1,
    })
    const row = tables.retentionMedia[0]
    expect(row.lastError).toContain('503')
    row.nextAttemptAt = now
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
    expect(await handler<ActionCtx>(drain)(ctx as unknown as ActionCtx, {})).toEqual({
      processed: 1,
      failed: 0,
    })
    expect(tables.retentionMedia).toHaveLength(0)
  })
})

describe('Mux retention cleanup protocol', () => {
  beforeEach(() => {
    vi.stubEnv('MUX_TOKEN_ID', 'test')
    vi.stubEnv('MUX_TOKEN_SECRET', 'test')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  it('persists a completed direct upload asset before dropping its upload work item', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 412 }))
      .mockResolvedValueOnce(Response.json({ data: { status: 'asset_created', asset_id: 'late' } }))
    const remember = vi.fn(async () => true)
    await deleteRetentionResource({ kind: 'direct_upload', externalId: 'upload' }, remember)
    expect(remember).toHaveBeenCalledWith(['late'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('does not acknowledge an upload that is still in flight', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 412 }))
      .mockResolvedValueOnce(Response.json({ data: { status: 'waiting' } }))
    await expect(
      deleteRetentionResource({ kind: 'direct_upload', externalId: 'upload' }, async () => true),
    ).rejects.toThrow(/still in flight/)
  })
  it('disables a stream and durably inventories its recordings before deletion', async () => {
    const order: string[] = []
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      order.push(`${options?.method} ${String(url).split('/').at(-1)}`)
      return options?.method === 'GET'
        ? Response.json({ data: { recent_asset_ids: ['old'], active_asset_id: 'late' } })
        : new Response('')
    })
    await deleteRetentionResource({ kind: 'live_stream', externalId: 'stream' }, async (assets) => {
      expect(assets).toEqual(['old', 'late'])
      order.push('persist')
      return true
    })
    expect(order).toEqual(['PUT disable', 'GET stream', 'persist', 'DELETE stream'])
  })
  it('does not delete a stream when its durable asset checkpoint fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(Response.json({ data: { active_asset_id: 'late' } }))
    await expect(
      deleteRetentionResource({ kind: 'live_stream', externalId: 'stream' }, async () => false),
    ).rejects.toThrow(/lease lost/)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
