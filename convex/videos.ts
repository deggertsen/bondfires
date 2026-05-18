import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { action, internalAction, internalMutation, internalQuery } from './_generated/server'
import { auth } from './auth'

type PlaybackPolicy = 'public' | 'signed'
type LiveLatencyMode = 'standard' | 'reduced' | 'low'
type MuxRecord =
  | { table: 'bondfires'; document: Doc<'bondfires'> }
  | { table: 'bondfireVideos'; document: Doc<'bondfireVideos'> }

interface MuxDirectUploadResult {
  uploadId: string
  uploadUrl: string
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  recordType: 'bondfire' | 'response'
  expiresIn: number
}

interface MuxLiveStreamResult {
  liveStreamId: string
  liveSessionId: Id<'liveSessions'>
  playbackId?: string
  playbackUrl?: string
  ingest: {
    rtmpsUrl: string
    streamKey: string
  }
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  recordType: 'bondfire' | 'response'
}

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'
const DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS = 60 * 60
const MUX_READY_STATUSES = new Set(['ready'])
const MUX_FAILED_STATUSES = new Set(['errored', 'cancelled', 'timed_out'])
const MUX_LIVE_RTMPS_ENDPOINT = 'rtmps://global-live.mux.com/app'
const DEFAULT_MUX_LIVE_RECONNECT_WINDOW_SECONDS = 30

function getMuxConfig() {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error(
      'Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET in Convex environment variables.',
    )
  }

  return {
    tokenId,
    tokenSecret,
    playbackPolicy: readPlaybackPolicy(process.env.MUX_PLAYBACK_POLICY),
    liveLatencyMode: readLiveLatencyMode(process.env.MUX_LIVE_LATENCY_MODE),
    videoQuality: process.env.MUX_VIDEO_QUALITY ?? 'basic',
    uploadCorsOrigin: process.env.MUX_UPLOAD_CORS_ORIGIN ?? '*',
  }
}

function readPlaybackPolicy(value: string | undefined): PlaybackPolicy {
  return value === 'signed' ? 'signed' : 'public'
}

function readLiveLatencyMode(value: string | undefined): LiveLatencyMode {
  return value === 'standard' || value === 'reduced' || value === 'low' ? value : 'low'
}

function getMuxAuthorizationHeader(tokenId: string, tokenSecret: string): string {
  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`
}

function readObject(value: unknown, context = 'Mux API response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Unexpected ${context}`)
  }

  return value as Record<string, unknown>
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readString(value: unknown, fieldName: string): string {
  const result = readOptionalString(value)
  if (!result) {
    throw new Error(`Mux API response is missing ${fieldName}`)
  }

  return result
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseMuxData(payload: unknown): Record<string, unknown> {
  return readObject(readObject(payload).data, 'Mux API data')
}

function getMuxPlaybackId(asset: Record<string, unknown>): string | undefined {
  const playbackIds = asset.playback_ids
  if (!Array.isArray(playbackIds)) {
    return undefined
  }

  for (const playbackId of playbackIds) {
    if (typeof playbackId !== 'object' || playbackId === null || Array.isArray(playbackId)) {
      continue
    }

    const id = readOptionalString((playbackId as Record<string, unknown>).id)
    if (id) {
      return id
    }
  }

  return undefined
}

function getMuxPlaybackUrl(playbackId: string): string {
  return `https://stream.mux.com/${playbackId}.m3u8`
}

function getMuxThumbnailUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg`
}

function getMuxPreviewUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/animated.gif`
}

function parseMuxDurationMs(value: unknown): number | undefined {
  const numberValue =
    typeof value === 'string' && value.length > 0 ? Number(value) : readOptionalNumber(value)
  return typeof numberValue === 'number' && Number.isFinite(numberValue)
    ? Math.round(numberValue * 1000)
    : undefined
}

async function assertCanCreateInCamp(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    durationMs?: number
    tags?: string[]
  },
) {
  const [user, camp] = await Promise.all([ctx.db.get(args.userId), ctx.db.get(args.campId)])
  if (!user) {
    throw new Error('User not found')
  }
  if (!camp || camp.status !== 'active') {
    throw new Error('Camp not found')
  }

  const membership = await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', args.userId).eq('campId', args.campId))
    .first()

  if (membership?.status !== 'active') {
    throw new Error('Join this camp before sparking here')
  }

  const campGender = camp.rules.gender
  if (campGender && campGender !== 'any' && user.gender !== campGender) {
    throw new Error('This camp is limited to members who match its gender setting')
  }

  if (camp.rules.maxDurationMs && args.durationMs && args.durationMs > camp.rules.maxDurationMs) {
    throw new Error('This recording is longer than the camp allows')
  }

  if (camp.rules.requiresTradeTags) {
    const tags = args.tags ?? []
    if (!tags.includes('need') && !tags.includes('offer')) {
      throw new Error('The Trading Post requires a need or offer tag')
    }
  }
}

async function muxRequest(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const config = getMuxConfig()
  const response = await fetch(`${MUX_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Mux API request failed: ${response.status} ${message}`)
  }

  return readObject(await response.json())
}

async function findMuxRecordByUpload(
  ctx: MutationCtx,
  uploadId: string,
): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_mux_upload', (q) => q.eq('muxUploadId', uploadId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_mux_upload', (q) => q.eq('muxUploadId', uploadId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecordByAsset(ctx: MutationCtx, assetId: string): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_mux_asset', (q) => q.eq('muxAssetId', assetId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_mux_asset', (q) => q.eq('muxAssetId', assetId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecordByLiveStream(
  ctx: MutationCtx,
  liveStreamId: string,
): Promise<MuxRecord | null> {
  const bondfire = await ctx.db
    .query('bondfires')
    .withIndex('by_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
    .first()
  if (bondfire) {
    return { table: 'bondfires', document: bondfire }
  }

  const responseVideo = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
    .first()
  return responseVideo ? { table: 'bondfireVideos', document: responseVideo } : null
}

async function findMuxRecord(
  ctx: MutationCtx,
  args: { uploadId?: string; assetId?: string; liveStreamId?: string },
) {
  if (args.uploadId) {
    const byUpload = await findMuxRecordByUpload(ctx, args.uploadId)
    if (byUpload) {
      return byUpload
    }
  }

  if (args.assetId) {
    const byAsset = await findMuxRecordByAsset(ctx, args.assetId)
    if (byAsset) {
      return byAsset
    }
  }

  if (args.liveStreamId) {
    return await findMuxRecordByLiveStream(ctx, args.liveStreamId)
  }

  return null
}

async function markRecordAssetCreated(
  ctx: MutationCtx,
  record: MuxRecord,
  args: { assetId: string; assetStatus?: string },
) {
  const patch = {
    muxAssetId: args.assetId,
    muxAssetStatus: args.assetStatus ?? 'preparing',
    videoStatus: 'processing' as const,
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })
  } else {
    await ctx.db.patch(record.document._id, patch)
  }
}

async function markRecordReady(
  ctx: MutationCtx,
  record: MuxRecord,
  args: {
    assetId: string
    playbackId: string
    playbackPolicy?: PlaybackPolicy
    assetStatus?: string
    durationMs?: number
    muxAspectRatio?: string
    muxMaxResolution?: string
  },
) {
  const wasReady = (record.document.videoStatus ?? 'ready') === 'ready'
  const patch = {
    videoStatus: 'ready' as const,
    muxAssetStatus: args.assetStatus ?? 'ready',
    muxAssetId: args.assetId,
    muxPlaybackId: args.playbackId,
    muxPlaybackPolicy: args.playbackPolicy ?? record.document.muxPlaybackPolicy,
    muxAspectRatio: args.muxAspectRatio,
    muxMaxResolution: args.muxMaxResolution,
    durationMs: record.document.durationMs ?? args.durationMs,
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })

    if (!wasReady) {
      const user = await ctx.db.get(record.document.userId)
      if (user) {
        await ctx.db.patch(record.document.userId, {
          bondfireCount: (user.bondfireCount ?? 0) + 1,
          updatedAt: Date.now(),
        })
      }

      if (record.document.campId) {
        const camp = await ctx.db.get(record.document.campId)
        if (camp) {
          await ctx.db.patch(record.document.campId, {
            bondfireCount: (camp.bondfireCount ?? 0) + 1,
            updatedAt: Date.now(),
          })
        }
      }
      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
        bondfireId: record.document._id,
        creatorId: record.document.userId,
        creatorName: user?.displayName ?? user?.name ?? 'Someone',
      })
    }
    return
  }

  await ctx.db.patch(record.document._id, patch)

  if (wasReady || record.document.liveSessionId) {
    return
  }

  const [user, bondfire] = await Promise.all([
    ctx.db.get(record.document.userId),
    ctx.db.get(record.document.bondfireId),
  ])

  if (bondfire) {
    await ctx.db.patch(record.document.bondfireId, {
      videoCount: bondfire.videoCount + 1,
      updatedAt: Date.now(),
    })

    await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
      bondfireId: record.document.bondfireId,
      responderId: record.document.userId,
      responderName: user?.displayName ?? user?.name ?? 'Someone',
    })
  }

  if (user) {
    await ctx.db.patch(record.document.userId, {
      responseCount: (user.responseCount ?? 0) + 1,
      updatedAt: Date.now(),
    })
  }
}

async function markRecordErrored(
  ctx: MutationCtx,
  record: MuxRecord,
  args: { assetId?: string; assetStatus?: string },
) {
  const patch = {
    videoStatus: 'errored' as const,
    muxAssetId: args.assetId,
    muxAssetStatus: args.assetStatus ?? 'errored',
  }

  if (record.table === 'bondfires') {
    await ctx.db.patch(record.document._id, {
      ...patch,
      updatedAt: Date.now(),
    })
  } else {
    await ctx.db.patch(record.document._id, patch)
  }
}

// Fields shared by `bondfires` and `bondfireVideos` that we patch in response
// to live-session state transitions. Narrowing the type prevents accidental
// patches with fields that only exist on one of the two tables.
type LiveLinkedRecordPatch = {
  videoStatus?: 'waiting_for_upload' | 'processing' | 'live' | 'ready' | 'errored'
  muxAssetStatus?: string
  muxAssetId?: string
}

async function patchLinkedLiveRecord(
  ctx: MutationCtx,
  liveSession: Doc<'liveSessions'>,
  patch: LiveLinkedRecordPatch,
) {
  if (liveSession.bondfireVideoId) {
    await ctx.db.patch(liveSession.bondfireVideoId, patch)
    return
  }

  if (liveSession.bondfireId) {
    await ctx.db.patch(liveSession.bondfireId, {
      ...patch,
      updatedAt: Date.now(),
    })
  }
}

async function markLinkedLiveRecordProcessing(ctx: MutationCtx, liveSession: Doc<'liveSessions'>) {
  const livePatch = {
    videoStatus: 'processing' as const,
    muxAssetStatus: 'processing',
  }

  if (liveSession.bondfireVideoId) {
    const video = await ctx.db.get(liveSession.bondfireVideoId)
    if (video && (video.videoStatus ?? 'ready') === 'live') {
      await ctx.db.patch(liveSession.bondfireVideoId, livePatch)
    }
    return
  }

  if (liveSession.bondfireId) {
    const bondfire = await ctx.db.get(liveSession.bondfireId)
    if (bondfire && (bondfire.videoStatus ?? 'ready') === 'live') {
      await ctx.db.patch(liveSession.bondfireId, {
        ...livePatch,
        updatedAt: Date.now(),
      })
    }
  }
}

async function markLinkedLiveRecordErrored(ctx: MutationCtx, liveSession: Doc<'liveSessions'>) {
  // Never went live → no recorded asset will arrive, so mark the bondfire
  // permanently errored. Already went live → the playback URL is dead, so
  // demote it to 'processing' and let the recorded-asset webhook either
  // promote it to 'ready' or mark it errored later.
  if (liveSession.startedAt) {
    await patchLinkedLiveRecord(ctx, liveSession, {
      videoStatus: 'processing',
      muxAssetStatus: 'processing',
    })
    return
  }

  await patchLinkedLiveRecord(ctx, liveSession, {
    videoStatus: 'errored',
    muxAssetStatus: 'errored',
  })
}

function readMuxAssetInfo(asset: Record<string, unknown>) {
  const playbackId = getMuxPlaybackId(asset)
  return {
    assetId: readString(asset.id, 'asset id'),
    playbackId,
    assetStatus: readOptionalString(asset.status),
    durationMs: parseMuxDurationMs(asset.duration),
    muxAspectRatio: readOptionalString(asset.aspect_ratio),
    muxMaxResolution: readOptionalString(asset.max_stored_resolution),
  }
}

export const createMuxDirectUpload = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    tags: v.optional(v.array(v.string())),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MuxDirectUploadResult> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    if (args.isResponse && !args.bondfireId) {
      throw new Error('A bondfire ID is required when uploading a response')
    }

    if (!args.isResponse) {
      if (!args.campId) {
        throw new Error('Choose a camp before sparking a Bondfire')
      }

      await ctx.runQuery(internal.videos.validateCreateCampContext, {
        userId,
        campId: args.campId,
        durationMs: args.durationMs,
        tags: args.tags,
      })
    }

    const config = getMuxConfig()
    const uploadTimeout = Number(
      process.env.MUX_UPLOAD_TIMEOUT_SECONDS ?? DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS,
    )
    const payload = {
      cors_origin: config.uploadCorsOrigin,
      timeout:
        Number.isFinite(uploadTimeout) && uploadTimeout > 0
          ? uploadTimeout
          : DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS,
      new_asset_settings: {
        playback_policies: [config.playbackPolicy],
        video_quality: config.videoQuality,
        passthrough: JSON.stringify({
          userId,
          isResponse: args.isResponse,
          bondfireId: args.bondfireId,
          campId: args.campId,
          tags: args.tags,
          filename: args.filename,
          contentType: args.contentType,
        }),
      },
    }

    const data = parseMuxData(
      await muxRequest('/uploads', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    )
    const uploadId = readString(data.id, 'upload id')
    const uploadUrl = readString(data.url, 'upload url')
    const expiresIn = readOptionalNumber(data.timeout) ?? payload.timeout

    const pendingRecord: {
      recordId: Id<'bondfires'> | Id<'bondfireVideos'>
      recordType: 'bondfire' | 'response'
    } = await ctx.runMutation(internal.videos.createPendingMuxVideo, {
      userId,
      uploadId,
      isResponse: args.isResponse,
      bondfireId: args.bondfireId,
      campId: args.campId,
      tags: args.tags,
      playbackPolicy: config.playbackPolicy,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
    })

    return {
      uploadId,
      uploadUrl,
      recordId: pendingRecord.recordId,
      recordType: pendingRecord.recordType,
      expiresIn,
    }
  },
})

export const getMuxUploadStatus = action({
  args: {
    uploadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const upload = parseMuxData(await muxRequest(`/uploads/${args.uploadId}`))
    const uploadStatus = readOptionalString(upload.status) ?? 'waiting'
    const assetId = readOptionalString(upload.asset_id)
    let assetStatus: string | undefined
    let playbackId: string | undefined
    let durationMs: number | undefined
    let muxAspectRatio: string | undefined
    let muxMaxResolution: string | undefined

    if (assetId) {
      await ctx.runMutation(internal.videos.markMuxAssetCreated, {
        uploadId: args.uploadId,
        assetId,
        assetStatus: 'preparing',
      })

      const asset = parseMuxData(await muxRequest(`/assets/${assetId}`))
      const assetInfo = readMuxAssetInfo(asset)
      assetStatus = assetInfo.assetStatus
      playbackId = assetInfo.playbackId
      durationMs = assetInfo.durationMs
      muxAspectRatio = assetInfo.muxAspectRatio
      muxMaxResolution = assetInfo.muxMaxResolution

      if (assetStatus && MUX_READY_STATUSES.has(assetStatus) && playbackId) {
        await ctx.runMutation(internal.videos.markMuxAssetReady, {
          uploadId: args.uploadId,
          assetId,
          playbackId,
          playbackPolicy: getMuxConfig().playbackPolicy,
          assetStatus,
          durationMs,
          muxAspectRatio,
          muxMaxResolution,
        })
      } else if (assetStatus && MUX_FAILED_STATUSES.has(assetStatus)) {
        await ctx.runMutation(internal.videos.markMuxAssetErrored, {
          uploadId: args.uploadId,
          assetId,
          assetStatus,
        })
      }
    } else if (MUX_FAILED_STATUSES.has(uploadStatus)) {
      await ctx.runMutation(internal.videos.markMuxAssetErrored, {
        uploadId: args.uploadId,
        assetStatus: uploadStatus,
      })
    }

    return {
      uploadStatus,
      assetStatus,
      assetId,
      playbackId,
      isReady: !!playbackId && assetStatus !== undefined && MUX_READY_STATUSES.has(assetStatus),
      isFailed:
        MUX_FAILED_STATUSES.has(uploadStatus) ||
        (assetStatus !== undefined && MUX_FAILED_STATUSES.has(assetStatus)),
    }
  },
})

export const createLiveStream = action({
  args: {
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    tags: v.optional(v.array(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MuxLiveStreamResult> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    if (args.isResponse && !args.bondfireId) {
      throw new Error('A bondfire ID is required when creating a live response')
    }

    if (!args.isResponse) {
      if (!args.campId) {
        throw new Error('Choose a camp before sparking a Bondfire')
      }

      await ctx.runQuery(internal.videos.validateCreateCampContext, {
        userId,
        campId: args.campId,
        tags: args.tags,
      })
    }

    // Refuse to provision a billable Mux live stream while the user already
    // has one in flight. The cron will sweep abandoned sessions, but this
    // prevents a runaway loop from creating an unbounded number of them.
    const existingActive: Doc<'liveSessions'> | null = await ctx.runQuery(
      internal.videos.getActiveMuxLiveSessionForUser,
      { userId },
    )
    if (existingActive) {
      throw new Error('You already have an active live stream. End it before starting a new one.')
    }

    const config = getMuxConfig()
    const reconnectWindow = Number(
      process.env.MUX_LIVE_RECONNECT_WINDOW_SECONDS ?? DEFAULT_MUX_LIVE_RECONNECT_WINDOW_SECONDS,
    )
    const data = parseMuxData(
      await muxRequest('/live-streams', {
        method: 'POST',
        body: JSON.stringify({
          playback_policies: [config.playbackPolicy],
          latency_mode: config.liveLatencyMode,
          reconnect_window:
            Number.isFinite(reconnectWindow) && reconnectWindow >= 0
              ? reconnectWindow
              : DEFAULT_MUX_LIVE_RECONNECT_WINDOW_SECONDS,
          new_asset_settings: {
            playback_policies: [config.playbackPolicy],
            video_quality: config.videoQuality,
            passthrough: JSON.stringify({
              userId,
              isResponse: args.isResponse,
              bondfireId: args.bondfireId,
              source: 'bondfires-live',
            }),
          },
        }),
      }),
    )
    const liveStreamId = readString(data.id, 'live stream id')
    const streamKey = readString(data.stream_key, 'stream key')
    const playbackId = getMuxPlaybackId(data)

    const pendingRecord: {
      liveSessionId: Id<'liveSessions'>
      recordId: Id<'bondfires'> | Id<'bondfireVideos'>
      recordType: 'bondfire' | 'response'
    } = await ctx.runMutation(internal.videos.createLinkedMuxLiveSession, {
      userId,
      liveStreamId,
      playbackId,
      isResponse: args.isResponse,
      bondfireId: args.bondfireId,
      campId: args.campId,
      playbackPolicy: config.playbackPolicy,
      latencyMode: config.liveLatencyMode,
      tags: args.tags,
      width: args.width,
      height: args.height,
    })

    return {
      liveStreamId,
      liveSessionId: pendingRecord.liveSessionId,
      playbackId,
      ingest: {
        rtmpsUrl: MUX_LIVE_RTMPS_ENDPOINT,
        streamKey,
      },
      playbackUrl: playbackId ? getMuxPlaybackUrl(playbackId) : undefined,
      recordId: pendingRecord.recordId,
      recordType: pendingRecord.recordType,
    }
  },
})

export const endLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ended: boolean }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    return await ctx.runMutation(internal.videos.markMuxLiveSessionEnding, {
      userId,
      liveSessionId: args.liveSessionId,
      reason: args.reason,
    })
  },
})

export const cancelLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ cancelled: boolean }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const liveSession: Doc<'liveSessions'> | null = await ctx.runQuery(
      internal.videos.getMuxLiveSessionForUser,
      {
        userId,
        liveSessionId: args.liveSessionId,
      },
    )

    if (!liveSession) {
      throw new Error('Live session not found')
    }

    try {
      await muxRequest(`/live-streams/${liveSession.muxLiveStreamId}`, {
        method: 'DELETE',
      })
    } catch (error) {
      console.warn('Failed to delete Mux live stream during cancellation:', error)
      throw new Error('Failed to cancel Mux live stream')
    }

    return await ctx.runMutation(internal.videos.cancelMuxLiveSessionRecord, {
      userId,
      liveSessionId: args.liveSessionId,
      reason: args.reason ?? 'cancelled',
    })
  },
})

export const disableStaleLiveStreams = internalAction({
  args: {},
  handler: async (ctx) => {
    const staleSessions: Doc<'liveSessions'>[] = await ctx.runQuery(
      internal.videos.listStaleMuxLiveSessions,
      {},
    )

    let disabled = 0
    let failed = 0

    for (const session of staleSessions) {
      try {
        await muxRequest(`/live-streams/${session.muxLiveStreamId}/disable`, {
          method: 'PUT',
        })
      } catch (error) {
        console.warn('Failed to disable stale Mux live stream:', session.muxLiveStreamId, error)
        failed += 1
        continue
      }

      await ctx.runMutation(internal.videos.markStaleMuxLiveSessionEnded, {
        liveSessionId: session._id,
      })
      disabled += 1
    }

    return { disabled, failed }
  },
})

// Generate URLs for Mux playback.
export const getVideoUrls = action({
  args: {
    muxPlaybackId: v.string(),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  },
  handler: async (_ctx, args) => {
    if (args.muxPlaybackPolicy === 'signed') {
      throw new Error('Signed Mux playback is not implemented yet')
    }

    return {
      hdUrl: getMuxPlaybackUrl(args.muxPlaybackId),
      sdUrl: null,
      thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
      expiresIn: 0,
    }
  },
})

export const getThumbnailUrl = action({
  args: {
    muxPlaybackId: v.string(),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  },
  handler: async (_ctx, args) => {
    if (args.muxPlaybackPolicy === 'signed') {
      throw new Error('Signed Mux thumbnails are not implemented yet')
    }

    return {
      thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
      previewUrl: getMuxPreviewUrl(args.muxPlaybackId),
      expiresIn: 0,
    }
  },
})

export const validateCreateCampContext = internalQuery({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertCanCreateInCamp(ctx, args)
    return { valid: true }
  },
})

export const createPendingMuxVideo = internalMutation({
  args: {
    userId: v.id('users'),
    uploadId: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    tags: v.optional(v.array(v.string())),
    playbackPolicy: v.union(v.literal('public'), v.literal('signed')),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await ctx.db.get(args.userId)

    if (args.isResponse) {
      if (!args.bondfireId) {
        throw new Error('A bondfire ID is required when creating a pending response upload')
      }

      const bondfire = await ctx.db.get(args.bondfireId)
      if (!bondfire) {
        throw new Error('Bondfire not found')
      }

      const existingVideos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId as Id<'bondfires'>))
        .collect()
      const sequenceNumber = existingVideos.length + 1
      const recordId = await ctx.db.insert('bondfireVideos', {
        bondfireId: args.bondfireId,
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        sequenceNumber,
        videoStatus: 'waiting_for_upload',
        muxUploadId: args.uploadId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: 'waiting_for_upload',
        durationMs: args.durationMs,
        width: args.width,
        height: args.height,
        tags: args.tags,
        createdAt: now,
      })

      return { recordId, recordType: 'response' as const }
    }

    if (!args.campId) {
      throw new Error('Choose a camp before sparking a Bondfire')
    }

    await assertCanCreateInCamp(ctx, {
      userId: args.userId,
      campId: args.campId,
      durationMs: args.durationMs,
      tags: args.tags,
    })

    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      campId: args.campId,
      videoStatus: 'waiting_for_upload',
      muxUploadId: args.uploadId,
      muxPlaybackPolicy: args.playbackPolicy,
      muxAssetStatus: 'waiting_for_upload',
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    return { recordId, recordType: 'bondfire' as const }
  },
})

export const deleteLegacyVideoOnDemandContent = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const [bondfires, responseVideos] = await Promise.all([
      ctx.db.query('bondfires').collect(),
      ctx.db.query('bondfireVideos').collect(),
    ])
    const legacyBondfires = bondfires.filter(
      (bondfire) => !bondfire.muxUploadId && !bondfire.muxAssetId && !bondfire.muxPlaybackId,
    )
    const legacyBondfireIds = new Set(legacyBondfires.map((bondfire) => bondfire._id))
    const legacyResponseVideos = responseVideos.filter(
      (video) =>
        !video.muxUploadId &&
        !video.muxAssetId &&
        !video.muxPlaybackId &&
        !legacyBondfireIds.has(video.bondfireId),
    )

    if (args.dryRun) {
      return {
        bondfiresToDelete: legacyBondfires.length,
        responseVideosToDelete: legacyResponseVideos.length,
      }
    }

    const affectedUsers = new Set<Id<'users'>>()
    const affectedBondfires = new Set<Id<'bondfires'>>()

    for (const video of legacyResponseVideos) {
      affectedUsers.add(video.userId)
      affectedBondfires.add(video.bondfireId)
      await ctx.db.delete(video._id)
    }

    for (const bondfire of legacyBondfires) {
      affectedUsers.add(bondfire.userId)

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        affectedUsers.add(response.userId)
        await ctx.db.delete(response._id)
      }

      await ctx.db.delete(bondfire._id)
    }

    for (const bondfireId of affectedBondfires) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) {
        continue
      }

      const readyResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()

      await ctx.db.patch(bondfireId, {
        videoCount:
          1 +
          readyResponses.filter(
            (video) => (video.videoStatus ?? 'ready') === 'ready' && video.muxPlaybackId,
          ).length,
        updatedAt: Date.now(),
      })
    }

    for (const userId of affectedUsers) {
      const [userBondfires, userResponses] = await Promise.all([
        ctx.db
          .query('bondfires')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
        ctx.db
          .query('bondfireVideos')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
      ])

      await ctx.db.patch(userId, {
        bondfireCount: userBondfires.filter(
          (bondfire) => (bondfire.videoStatus ?? 'ready') === 'ready' && bondfire.muxPlaybackId,
        ).length,
        responseCount: userResponses.filter(
          (video) => (video.videoStatus ?? 'ready') === 'ready' && video.muxPlaybackId,
        ).length,
        updatedAt: Date.now(),
      })
    }

    return {
      deletedBondfires: legacyBondfires.length,
      deletedResponseVideos: legacyResponseVideos.length,
    }
  },
})

export const markMuxAssetCreated = internalMutation({
  args: {
    uploadId: v.string(),
    assetId: v.string(),
    assetStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    await markRecordAssetCreated(ctx, record, args)
    return { updated: true }
  },
})

export const markMuxAssetReady = internalMutation({
  args: {
    uploadId: v.optional(v.string()),
    assetId: v.string(),
    playbackId: v.string(),
    playbackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    assetStatus: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    muxAspectRatio: v.optional(v.string()),
    muxMaxResolution: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    await markRecordReady(ctx, record, args)
    return { updated: true }
  },
})

export const markMuxAssetErrored = internalMutation({
  args: {
    uploadId: v.optional(v.string()),
    assetId: v.optional(v.string()),
    assetStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await findMuxRecord(ctx, args)
    if (!record) {
      return { updated: false }
    }

    await markRecordErrored(ctx, record, args)
    return { updated: true }
  },
})

export const createLinkedMuxLiveSession = internalMutation({
  args: {
    userId: v.id('users'),
    liveStreamId: v.string(),
    playbackId: v.optional(v.string()),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    playbackPolicy: v.union(v.literal('public'), v.literal('signed')),
    latencyMode: v.union(v.literal('standard'), v.literal('reduced'), v.literal('low')),
    tags: v.optional(v.array(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await ctx.db.get(args.userId)
    const liveSessionId = await ctx.db.insert('liveSessions', {
      userId: args.userId,
      muxLiveStreamId: args.liveStreamId,
      muxLivePlaybackId: args.playbackId,
      transport: 'rtmps',
      latencyMode: args.latencyMode,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    })

    if (args.isResponse) {
      if (!args.bondfireId) {
        throw new Error('A bondfire ID is required when creating a live response')
      }

      const bondfire = await ctx.db.get(args.bondfireId)
      if (!bondfire) {
        throw new Error('Bondfire not found')
      }

      const existingVideos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId as Id<'bondfires'>))
        .collect()
      const sequenceNumber = existingVideos.length + 1
      const recordId = await ctx.db.insert('bondfireVideos', {
        bondfireId: args.bondfireId,
        userId: args.userId,
        creatorName: user?.displayName ?? user?.name,
        sequenceNumber,
        liveSessionId,
        videoStatus: 'live',
        muxLiveStreamId: args.liveStreamId,
        muxLivePlaybackId: args.playbackId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: 'live',
        width: args.width,
        height: args.height,
        tags: args.tags,
        createdAt: now,
      })

      await ctx.db.patch(args.bondfireId, {
        videoCount: bondfire.videoCount + 1,
        updatedAt: now,
      })

      if (user) {
        await ctx.db.patch(args.userId, {
          responseCount: (user.responseCount ?? 0) + 1,
          updatedAt: now,
        })
      }

      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireResponse, {
        bondfireId: args.bondfireId,
        responderId: args.userId,
        responderName: user?.displayName ?? user?.name ?? 'Someone',
      })

      await ctx.db.patch(liveSessionId, {
        bondfireVideoId: recordId,
        updatedAt: now,
      })

      return { liveSessionId, recordId, recordType: 'response' as const }
    }

    if (!args.campId) {
      throw new Error('Choose a camp before sparking a Bondfire')
    }

    await assertCanCreateInCamp(ctx, {
      userId: args.userId,
      campId: args.campId,
      tags: args.tags,
    })

    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      campId: args.campId,
      liveSessionId,
      videoStatus: 'live',
      muxLiveStreamId: args.liveStreamId,
      muxLivePlaybackId: args.playbackId,
      muxPlaybackPolicy: args.playbackPolicy,
      muxAssetStatus: 'live',
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.patch(liveSessionId, {
      bondfireId: recordId,
      updatedAt: now,
    })

    return { liveSessionId, recordId, recordType: 'bondfire' as const }
  },
})

export const getMuxLiveSessionForUser = internalQuery({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      return null
    }

    return liveSession
  },
})

export const getActiveMuxLiveSessionForUser = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<Doc<'liveSessions'> | null> => {
    const sessions = await ctx.db
      .query('liveSessions')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(10)

    const activeStatuses = new Set(['created', 'starting', 'live', 'ending'])
    return sessions.find((session) => activeStatuses.has(session.status)) ?? null
  },
})

export const listStaleMuxLiveSessions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const staleBefore = Date.now() - 5 * 60 * 1000
    // 'created' covers sessions where the client errored before going live —
    // those would otherwise stay parked on Mux billing forever.
    const statuses = ['created', 'starting', 'live', 'ending'] as const
    const batches = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query('liveSessions')
          .withIndex('by_status', (q) => q.eq('status', status))
          .order('asc')
          .take(50),
      ),
    )

    return batches.flat().filter((session) => session.updatedAt < staleBefore)
  },
})

export const markMuxLiveSessionEnding = internalMutation({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      throw new Error('Live session not found')
    }

    const now = Date.now()
    await ctx.db.patch(args.liveSessionId, {
      status: 'ending',
      errorMessage: args.reason,
      updatedAt: now,
    })

    return { ended: true }
  },
})

export const cancelMuxLiveSessionRecord = internalMutation({
  args: {
    userId: v.id('users'),
    liveSessionId: v.id('liveSessions'),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession || liveSession.userId !== args.userId) {
      throw new Error('Live session not found')
    }

    if (liveSession.bondfireVideoId) {
      const video = await ctx.db.get(liveSession.bondfireVideoId)
      if (video) {
        const [bondfire, user] = await Promise.all([
          ctx.db.get(video.bondfireId),
          ctx.db.get(video.userId),
        ])

        if (bondfire) {
          await ctx.db.patch(video.bondfireId, {
            videoCount: Math.max(1, bondfire.videoCount - 1),
            updatedAt: Date.now(),
          })
        }

        if (user) {
          await ctx.db.patch(video.userId, {
            responseCount: Math.max(0, (user.responseCount ?? 0) - 1),
            updatedAt: Date.now(),
          })
        }
      }

      await ctx.db.delete(liveSession.bondfireVideoId)
    }
    if (liveSession.bondfireId && !liveSession.bondfireVideoId) {
      await ctx.db.delete(liveSession.bondfireId)
    }

    await ctx.db.patch(args.liveSessionId, {
      status: 'ended',
      endedAt: Date.now(),
      errorMessage: args.reason,
      updatedAt: Date.now(),
    })

    return { cancelled: true }
  },
})

export const markStaleMuxLiveSessionEnded = internalMutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx, args) => {
    const liveSession = await ctx.db.get(args.liveSessionId)
    if (!liveSession) {
      return { updated: false }
    }

    const now = Date.now()
    await ctx.db.patch(args.liveSessionId, {
      status: 'ended',
      endedAt: liveSession.endedAt ?? now,
      errorMessage: liveSession.errorMessage ?? 'stale live session disabled',
      updatedAt: now,
    })
    await markLinkedLiveRecordErrored(ctx, liveSession)

    return { updated: true }
  },
})

export const handleMuxWebhookEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    dataJson: v.string(),
  },
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query('muxWebhookEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first()

    if (existingEvent) {
      return { ignored: true }
    }

    await ctx.db.insert('muxWebhookEvents', {
      eventId: args.eventId,
      eventType: args.eventType,
      createdAt: Date.now(),
    })

    const data = readObject(JSON.parse(args.dataJson), 'Mux webhook data')
    const uploadId = readOptionalString(data.upload_id) ?? readOptionalString(data.id)
    const assetId =
      readOptionalString(data.asset_id) ??
      (args.eventType.startsWith('video.asset.') ? readOptionalString(data.id) : undefined)
    const assetStatus = readOptionalString(data.status)
    const liveStreamId = readOptionalString(data.live_stream_id)

    if (args.eventType === 'video.upload.asset_created' && uploadId && assetId) {
      const record = await findMuxRecord(ctx, { uploadId, assetId })
      if (record) {
        await markRecordAssetCreated(ctx, record, { assetId, assetStatus })
      }
      return { handled: true }
    }

    if (args.eventType === 'video.asset.ready' && assetId) {
      const playbackId = getMuxPlaybackId(data)
      const record = await findMuxRecord(ctx, { uploadId, assetId, liveStreamId })
      if (record && playbackId) {
        await markRecordReady(ctx, record, {
          assetId,
          playbackId,
          assetStatus: assetStatus ?? 'ready',
          durationMs: parseMuxDurationMs(data.duration),
          muxAspectRatio: readOptionalString(data.aspect_ratio),
          muxMaxResolution: readOptionalString(data.max_stored_resolution),
        })
      }

      if (liveStreamId) {
        const liveSession = await ctx.db
          .query('liveSessions')
          .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
          .first()
        if (liveSession) {
          await ctx.db.patch(liveSession._id, {
            muxRecordedAssetId: assetId,
            muxRecentAssetId: assetId,
            updatedAt: Date.now(),
          })
        }
      }
      return { handled: true }
    }

    if (
      ['video.asset.errored', 'video.upload.cancelled', 'video.upload.timed_out'].includes(
        args.eventType,
      )
    ) {
      const record = await findMuxRecord(ctx, { uploadId, assetId, liveStreamId })
      if (record) {
        await markRecordErrored(ctx, record, { assetId, assetStatus })
      }
      return { handled: true }
    }

    if (args.eventType.startsWith('video.live_stream.')) {
      // For live_stream.* events, the live stream id is the top-level `id`,
      // not the `live_stream_id` shadowed at the top of this handler.
      const eventLiveStreamId = readOptionalString(data.id)
      if (!eventLiveStreamId) {
        return { handled: false }
      }

      const liveSession = await ctx.db
        .query('liveSessions')
        .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', eventLiveStreamId))
        .first()

      if (!liveSession) {
        return { handled: false }
      }

      const now = Date.now()
      if (args.eventType === 'video.live_stream.connected') {
        await ctx.db.patch(liveSession._id, {
          status: 'starting',
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.active') {
        await ctx.db.patch(liveSession._id, {
          status: 'live',
          startedAt: liveSession.startedAt ?? now,
          muxActiveAssetId:
            readOptionalString(data.active_asset_id) ?? liveSession.muxActiveAssetId,
          updatedAt: now,
        })
        await patchLinkedLiveRecord(ctx, liveSession, {
          videoStatus: 'live',
          muxAssetStatus: 'live',
        })
        if (liveSession.bondfireId && !liveSession.bondfireVideoId && !liveSession.startedAt) {
          const user = await ctx.db.get(liveSession.userId)
          await ctx.scheduler.runAfter(0, internal.sendNotification.notifyBondfireLive, {
            bondfireId: liveSession.bondfireId,
            creatorId: liveSession.userId,
            creatorName: user?.displayName ?? user?.name ?? 'Someone',
          })
        }
      } else if (args.eventType === 'video.live_stream.disconnected') {
        await ctx.db.patch(liveSession._id, {
          status: 'ending',
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.idle') {
        await ctx.db.patch(liveSession._id, {
          status: 'ended',
          endedAt: now,
          muxRecentAssetId:
            readOptionalString(data.recent_asset_id) ?? liveSession.muxRecentAssetId,
          updatedAt: now,
        })
        await markLinkedLiveRecordProcessing(ctx, liveSession)
      } else if (args.eventType === 'video.live_stream.errored') {
        await ctx.db.patch(liveSession._id, {
          status: 'errored',
          errorMessage: readOptionalString(data.error_message),
          updatedAt: now,
        })
        await markLinkedLiveRecordErrored(ctx, liveSession)
      }

      return { handled: true }
    }

    return { handled: false }
  },
})
