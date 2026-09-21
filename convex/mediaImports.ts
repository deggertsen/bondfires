import { v } from 'convex/values'
import { MEDIA_AUDIENCE, signCapability } from '../packages/media/src/protocol'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { auth } from './auth'
import { assertCanViewBondfire, assertCanViewResponse } from './videos'

const recordId = v.union(v.id('bondfires'), v.id('bondfireVideos'))
// Deployment-key-only operations: imports never enter the recording publication path.
export const stage = internalMutation({
  args: { recordId, muxAssetId: v.string(), muxPlaybackId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.recordId)
    if (
      !record ||
      record.videoStatus !== 'ready' ||
      record.segmentRecordingId ||
      record.muxAssetId !== args.muxAssetId ||
      record.muxPlaybackId !== args.muxPlaybackId
    )
      throw new Error('Source changed or is ineligible')
    const existing = await ctx.db
      .query('mediaImports')
      .withIndex('by_record', (q) => q.eq('recordId', args.recordId))
      .unique()
    if (existing) {
      if (existing.muxAssetId !== args.muxAssetId || existing.muxPlaybackId !== args.muxPlaybackId)
        throw new Error('Source changed')
      return existing._id
    }
    return ctx.db.insert('mediaImports', {
      ...args,
      status: 'staging',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})
export const activate = internalMutation({
  args: { importId: v.id('mediaImports'), manifestChecksum: v.string(), duration: v.number() },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.importId)
    const record = item && (await ctx.db.get(item.recordId))
    if (
      !item ||
      !record ||
      record.segmentRecordingId ||
      record.videoStatus !== 'ready' ||
      record.muxAssetId !== item.muxAssetId ||
      record.muxPlaybackId !== item.muxPlaybackId
    )
      throw new Error('Source changed or deleted')
    if (
      !/^[a-f0-9]{64}$/.test(args.manifestChecksum) ||
      !Number.isFinite(args.duration) ||
      args.duration <= 0
    )
      throw new Error('Invalid verification')
    if (item.manifestChecksum && item.manifestChecksum !== args.manifestChecksum)
      throw new Error('Import is immutable')
    await ctx.db.patch(item._id, {
      status: 'ready',
      manifestChecksum: args.manifestChecksum,
      duration: args.duration,
      updatedAt: Date.now(),
    })
  },
})
export const rollback = internalMutation({
  args: { importId: v.id('mediaImports') },
  handler: async (ctx, args) =>
    ctx.db.patch(args.importId, { status: 'rollback', updatedAt: Date.now() }),
})
export const lookup = internalQuery({
  args: { recordId, muxPlaybackId: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query('mediaImports')
      .withIndex('by_record', (q) => q.eq('recordId', args.recordId))
      .unique()
    return item?.status === 'ready' && item.muxPlaybackId === args.muxPlaybackId ? item : null
  },
})
export const authorize = internalQuery({
  args: { importId: v.id('mediaImports'), userId: v.optional(v.id('users')) },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.importId)
    if (!item || item.status !== 'ready') throw new Error('Forbidden')
    const record = await ctx.db.get(item.recordId)
    if (
      !record ||
      record.segmentRecordingId ||
      record.muxAssetId !== item.muxAssetId ||
      record.muxPlaybackId !== item.muxPlaybackId ||
      record.videoStatus !== 'ready'
    )
      throw new Error('Forbidden')
    if (args.userId) {
      const user = await ctx.db.get(args.userId)
      if (!user || user.accountDeletionStatus) throw new Error('Forbidden')
    }
    const owner = await ctx.db.get(record.userId)
    if (!owner || owner.accountDeletionStatus) throw new Error('Forbidden')
    if ('bondfireId' in record) {
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now())
        throw new Error('Forbidden')
      const bondfire = await ctx.db.get(record.bondfireId)
      if (!bondfire) throw new Error('Forbidden')
      await assertCanViewResponse(ctx, { userId: args.userId ?? null, bondfire, response: record })
    } else await assertCanViewBondfire(ctx, { userId: args.userId ?? null, bondfire: record })
    return { manifestChecksum: item.manifestChecksum }
  },
})
export async function importedUrls(
  ctx: ActionCtx,
  args: {
    muxPlaybackId: string
    bondfireId?: Id<'bondfires'>
    bondfireVideoId?: Id<'bondfireVideos'>
  },
): Promise<{
  hdUrl: string
  thumbnailUrl: string
  previewUrl: string
  captionsUrl: string
  expiresIn: number
} | null> {
  const id = args.bondfireVideoId ?? args.bondfireId
  if (!id) return null
  const item = await ctx.runQuery(internal.mediaImports.lookup, {
    recordId: id,
    muxPlaybackId: args.muxPlaybackId,
  })
  if (!item) return null
  const userId = (await auth.getUserId(ctx)) ?? undefined
  try {
    await ctx.runQuery(internal.mediaImports.authorize, { importId: item._id, userId })
  } catch {
    // Preserve batch isolation without handing an unauthorized viewer a legacy fallback.
    return { hdUrl: '', thumbnailUrl: '', previewUrl: '', captionsUrl: '', expiresIn: 0 }
  }
  const token = await signCapability(
    {
      audience: MEDIA_AUDIENCE,
      recordingId: item._id,
      userId: userId ?? '',
      operation: 'read',
      expiresAt: Date.now() + 12 * 3600_000,
    },
    process.env.MEDIA_TOKEN_SECRET ?? '',
  )
  const base = `${process.env.MEDIA_WORKER_URL}/imports/${item._id}`
  const url = (name: string) => `${base}/${name}?token=${encodeURIComponent(token)}`
  return {
    hdUrl: url('index.m3u8'),
    thumbnailUrl: url('thumbnail.jpg'),
    previewUrl: url('preview.gif'),
    captionsUrl: url('captions.vtt'),
    expiresIn: 12 * 3600,
  }
}

export const orphanPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('mediaImports').paginate({ cursor, numItems: 100 })
    const orphanIds: Id<'mediaImports'>[] = []
    for (const item of page.page) {
      const record = await ctx.db.get(item.recordId)
      if (!record || record.muxAssetId !== item.muxAssetId || record.segmentRecordingId)
        orphanIds.push(item._id)
    }
    return { ...page, page: orphanIds }
  },
})
export const removeOrphan = internalMutation({
  args: { importId: v.id('mediaImports') },
  handler: async (ctx, { importId }) => {
    const item = await ctx.db.get(importId)
    if (item && !(await ctx.db.get(item.recordId))) await ctx.db.delete(importId)
  },
})
export const cleanup = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.runQuery(internal.mediaImports.orphanPage, { cursor: cursor ?? null })
    for (const importId of page.page) {
      const response = await fetch(`${process.env.MEDIA_WORKER_URL}/imports/${importId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.MEDIA_WORKER_SECRET}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error('Import cleanup failed')
      await ctx.runMutation(internal.mediaImports.removeOrphan, { importId })
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.mediaImports.cleanup, {
        cursor: page.continueCursor,
      })
  },
})
