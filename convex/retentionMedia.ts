import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalAction, internalMutation, type MutationCtx } from './_generated/server'

type MediaKind = Doc<'retentionMedia'>['kind']
const LEASE_MS = 5 * 60 * 1000
const MEDIA_BATCH_SIZE = 4

// Archive retired provider resources independently of R2 cleanup and account jobs.
export const enqueueUnlinked = internalMutation({
  args: {
    kind: v.union(v.literal('asset'), v.literal('direct_upload'), v.literal('live_stream')),
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    await enqueueRetentionMedia(ctx, args.kind, args.externalId)
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

/** Compatibility for jobs queued before retirement. Preserve the external
 * resource ledger for operator cleanup; never claim that assets were deleted. */
export const drain = internalAction({
  args: {},
  handler: async () => ({ processed: 0, failed: 0, retired: true }),
})
