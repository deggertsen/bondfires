import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalAction, internalMutation, type MutationCtx } from './_generated/server'

type MediaKind = Doc<'retentionMedia'>['kind']
const LEASE_MS = 5 * 60 * 1000
const MEDIA_BATCH_SIZE = 4

/** Compensation when deletion wins while an action is provisioning at Mux. */
export const enqueueUnlinked = internalMutation({
  args: {
    kind: v.union(v.literal('direct_upload'), v.literal('live_stream')),
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    await enqueueRetentionMedia(ctx, args.kind, args.externalId)
    await ctx.scheduler.runAfter(0, internal.retentionMedia.drain, {})
  },
})

export async function enqueueRetentionMedia(ctx: MutationCtx, kind: MediaKind, externalId: string) {
  const existing = await ctx.db
    .query('retentionMedia')
    .withIndex('by_external', (q) => q.eq('kind', kind).eq('externalId', externalId))
    .first()
  if (!existing) {
    await ctx.db.insert('retentionMedia', {
      kind,
      externalId,
      attempts: 0,
      nextAttemptAt: Date.now(),
    })
  }
}

export const claimBatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<Doc<'retentionMedia'>[]> => {
    const now = Date.now()
    const rows = await ctx.db
      .query('retentionMedia')
      .withIndex('by_next_attempt', (q) => q.lte('nextAttemptAt', now))
      .take(MEDIA_BATCH_SIZE)
    const claimed: Doc<'retentionMedia'>[] = []
    for (const row of rows) {
      // Legacy records can share a resource. Never delete it while another
      // video row still references it (including a child awaiting cleanup).
      const index =
        row.kind === 'asset'
          ? 'by_mux_asset'
          : row.kind === 'direct_upload'
            ? 'by_mux_upload'
            : 'by_live_stream'
      const field =
        row.kind === 'asset'
          ? 'muxAssetId'
          : row.kind === 'direct_upload'
            ? 'muxUploadId'
            : 'muxLiveStreamId'
      const root = await ctx.db
        .query('bondfires')
        .withIndex(index, (q) => q.eq(field, row.externalId))
        .first()
      const response = await ctx.db
        .query('bondfireVideos')
        .withIndex(index, (q) => q.eq(field, row.externalId))
        .first()
      if (root || response) {
        await ctx.db.patch(row._id, { nextAttemptAt: now + LEASE_MS })
        continue
      }
      const leased = { ...row, attempts: row.attempts + 1, nextAttemptAt: now + LEASE_MS }
      await ctx.db.patch(row._id, {
        attempts: leased.attempts,
        nextAttemptAt: leased.nextAttemptAt,
      })
      claimed.push(leased)
    }
    return claimed
  },
})

export const rememberAssets = internalMutation({
  args: { mediaId: v.id('retentionMedia'), attempt: v.number(), assetIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.mediaId)
    if (!row || row.attempts !== args.attempt) return false
    if (args.assetIds.length > 100) throw new Error('Unexpected Mux asset inventory size')
    for (const assetId of new Set(args.assetIds)) await enqueueRetentionMedia(ctx, 'asset', assetId)
    return true
  },
})

export const finishAttempt = internalMutation({
  args: { mediaId: v.id('retentionMedia'), attempt: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.mediaId)
    // An old timed-out worker must not erase a newer worker's retry state.
    if (!row || row.attempts !== args.attempt) return
    if (args.error !== undefined) {
      await ctx.db.patch(row._id, {
        lastError: args.error.slice(0, 500),
        nextAttemptAt:
          Date.now() + Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(row.attempts, 7)),
      })
    } else {
      await ctx.db.delete(row._id)
    }
  },
})

async function muxRequest(path: string, method: 'GET' | 'DELETE' | 'PUT') {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET
  if (!tokenId || !tokenSecret) throw new Error('Mux credentials are not configured')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(`https://api.mux.com/video/v1/${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`,
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** Resource IDs are immutable. 404 after an ambiguous prior success is success. */
export async function deleteRetentionResource(
  row: Pick<Doc<'retentionMedia'>, 'kind' | 'externalId'>,
  rememberAssets: (assetIds: string[]) => Promise<boolean>,
) {
  const id = encodeURIComponent(row.externalId)
  if (row.kind === 'direct_upload') {
    const cancelled = await muxRequest(`uploads/${id}/cancel`, 'PUT')
    if (cancelled.ok || cancelled.status === 404) return
    const lookup = await muxRequest(`uploads/${id}`, 'GET')
    if (lookup.status === 404) return
    if (!lookup.ok) throw new Error(`Mux upload lookup failed (${lookup.status})`)
    const payload = (await lookup.json()) as { data?: { status?: string; asset_id?: string } }
    if (payload.data?.asset_id) {
      // Persist a completed upload's asset BEFORE acknowledging the upload.
      if (!(await rememberAssets([payload.data.asset_id]))) throw new Error('Media lease lost')
      return
    }
    if (['cancelled', 'timed_out', 'errored'].includes(payload.data?.status ?? '')) return
    throw new Error('Mux upload is still in flight')
  }
  if (row.kind === 'live_stream') {
    const disabled = await muxRequest(`live-streams/${id}/disable`, 'PUT')
    if (disabled.status === 404) return
    if (!disabled.ok) throw new Error(`Mux stream disable failed (${disabled.status})`)
    const lookup = await muxRequest(`live-streams/${id}`, 'GET')
    if (lookup.status === 404) return
    if (!lookup.ok) throw new Error(`Mux stream lookup failed (${lookup.status})`)
    const payload = (await lookup.json()) as {
      data?: { active_asset_id?: string; recent_asset_ids?: string[] }
    }
    const assets = [...(payload.data?.recent_asset_ids ?? [])]
    if (payload.data?.active_asset_id) assets.push(payload.data.active_asset_id)
    // Stream deletion does not delete recordings. Save the final inventory
    // durably first, including recordings that arrived after the DB claim.
    if (!(await rememberAssets(assets))) throw new Error('Media lease lost')
  }
  const resource = row.kind === 'asset' ? 'assets' : 'live-streams'
  const deleted = await muxRequest(`${resource}/${id}`, 'DELETE')
  if (!deleted.ok && deleted.status !== 404)
    throw new Error(`Mux ${resource} deletion failed (${deleted.status})`)
}

export const drain = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number; failed: number }> => {
    const rows = await ctx.runMutation(internal.retentionMedia.claimBatch, {})
    let failed = 0
    for (const row of rows) {
      let error: string | undefined
      try {
        await deleteRetentionResource(
          row,
          async (assetIds) =>
            await ctx.runMutation(internal.retentionMedia.rememberAssets, {
              mediaId: row._id,
              attempt: row.attempts,
              assetIds,
            }),
        )
      } catch (err) {
        failed++
        error = err instanceof Error ? err.message : 'Unknown Mux cleanup error'
        console.error('[retention] Media cleanup will retry', {
          mediaId: row._id,
          attempt: row.attempts,
          error,
        })
      }
      await ctx.runMutation(internal.retentionMedia.finishAttempt, {
        mediaId: row._id,
        attempt: row.attempts,
        error,
      })
    }
    if (rows.length === MEDIA_BATCH_SIZE)
      await ctx.scheduler.runAfter(0, internal.retentionMedia.drain, {})
    return { processed: rows.length, failed }
  },
})
