import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { action, internalMutation } from './_generated/server'
import { auth } from './auth'

type PlaybackPolicy = 'public' | 'signed'
type MuxRecord =
  | { table: 'bondfires'; document: Doc<'bondfires'> }
  | { table: 'bondfireVideos'; document: Doc<'bondfireVideos'> }

interface MuxDirectUploadResult {
  storageProvider: 'mux'
  uploadId: string
  uploadUrl: string
  recordId: Id<'bondfires'> | Id<'bondfireVideos'>
  recordType: 'bondfire' | 'response'
  expiresIn: number
}

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'
const DEFAULT_MUX_UPLOAD_TIMEOUT_SECONDS = 60 * 60
const MUX_READY_STATUSES = new Set(['ready'])
const MUX_FAILED_STATUSES = new Set(['errored', 'cancelled', 'timed_out'])
const MUX_LIVE_RTMP_ENDPOINT = 'rtmp://global-live.mux.com:5222/app'

// Initialize S3 client
function getS3Client() {
  const region = process.env.AWS_REGION
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not configured. Please set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY in Convex environment variables.',
    )
  }

  return new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
}

function getBucket(): string {
  const bucket = process.env.S3_BUCKET_NAME
  if (!bucket) {
    throw new Error('S3_BUCKET_NAME not configured in Convex environment variables.')
  }
  return bucket
}

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
    videoQuality: process.env.MUX_VIDEO_QUALITY ?? 'basic',
    uploadCorsOrigin: process.env.MUX_UPLOAD_CORS_ORIGIN ?? '*',
  }
}

function readPlaybackPolicy(value: string | undefined): PlaybackPolicy {
  return value === 'signed' ? 'signed' : 'public'
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

async function findMuxRecord(ctx: MutationCtx, args: { uploadId?: string; assetId?: string }) {
  if (args.uploadId) {
    const byUpload = await findMuxRecordByUpload(ctx, args.uploadId)
    if (byUpload) {
      return byUpload
    }
  }

  if (args.assetId) {
    return await findMuxRecordByAsset(ctx, args.assetId)
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
    storageProvider: 'mux' as const,
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
    }
    return
  }

  await ctx.db.patch(record.document._id, patch)

  if (wasReady) {
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

// Generate a presigned URL for uploading a video to S3
export const getUploadUrl = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    quality: v.optional(v.union(v.literal('hd'), v.literal('sd'))),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const client = getS3Client()
    const bucket = getBucket()

    // Generate a unique key for the video
    const timestamp = Date.now()
    const quality = args.quality ?? 'hd'
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_')
    const key = `videos/${userId}/${timestamp}-${quality}-${sanitizedFilename}`

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType,
    })

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 })

    return {
      uploadUrl,
      key,
      expiresIn: 3600,
    }
  },
})

export const createMuxDirectUpload = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
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
      playbackPolicy: config.playbackPolicy,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
    })

    return {
      storageProvider: 'mux' as const,
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

export const createMuxLiveSession = action({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const config = getMuxConfig()
    const data = parseMuxData(
      await muxRequest('/live-streams', {
        method: 'POST',
        body: JSON.stringify({
          playback_policies: [config.playbackPolicy],
          new_asset_settings: {
            playback_policies: [config.playbackPolicy],
            video_quality: config.videoQuality,
          },
        }),
      }),
    )
    const liveStreamId = readString(data.id, 'live stream id')
    const streamKey = readString(data.stream_key, 'stream key')
    const playbackId = getMuxPlaybackId(data)

    await ctx.runMutation(internal.videos.createMuxLiveSessionRecord, {
      userId,
      liveStreamId,
      playbackId,
    })

    return {
      liveStreamId,
      playbackId,
      streamKey,
      rtmpEndpoint: MUX_LIVE_RTMP_ENDPOINT,
      playbackUrl: playbackId ? getMuxPlaybackUrl(playbackId) : undefined,
    }
  },
})

// Generate a presigned URL for downloading/streaming a video
export const getDownloadUrl = action({
  args: {
    key: v.string(),
  },
  handler: async (_ctx, args) => {
    const client = getS3Client()
    const bucket = getBucket()

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: args.key,
    })

    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 3600 })

    return {
      downloadUrl,
      expiresIn: 3600,
    }
  },
})

// Generate URLs for Mux playback or legacy S3 objects.
export const getVideoUrls = action({
  args: {
    hdKey: v.optional(v.string()),
    sdKey: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  },
  handler: async (_ctx, args) => {
    if (args.muxPlaybackId) {
      if (args.muxPlaybackPolicy === 'signed') {
        throw new Error('Signed Mux playback is not implemented yet')
      }

      return {
        hdUrl: getMuxPlaybackUrl(args.muxPlaybackId),
        sdUrl: null,
        thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
        expiresIn: 0,
      }
    }

    if (!args.hdKey) {
      throw new Error('No video storage reference provided')
    }

    const client = getS3Client()
    const bucket = getBucket()

    const hdCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: args.hdKey,
    })

    const hdUrl = await getSignedUrl(client, hdCommand, { expiresIn: 3600 })

    let sdUrl: string | null = null
    if (args.sdKey) {
      const sdCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: args.sdKey,
      })
      sdUrl = await getSignedUrl(client, sdCommand, { expiresIn: 3600 })
    }

    return {
      hdUrl,
      sdUrl,
      thumbnailUrl: null,
      expiresIn: 3600,
    }
  },
})

export const getThumbnailUrl = action({
  args: {
    thumbnailKey: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  },
  handler: async (_ctx, args) => {
    if (args.muxPlaybackId) {
      if (args.muxPlaybackPolicy === 'signed') {
        throw new Error('Signed Mux thumbnails are not implemented yet')
      }

      return {
        thumbnailUrl: getMuxThumbnailUrl(args.muxPlaybackId),
        previewUrl: getMuxPreviewUrl(args.muxPlaybackId),
        expiresIn: 0,
      }
    }

    if (!args.thumbnailKey) {
      return {
        thumbnailUrl: null,
        previewUrl: null,
        expiresIn: 0,
      }
    }

    const client = getS3Client()
    const bucket = getBucket()

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: args.thumbnailKey,
    })

    const thumbnailUrl = await getSignedUrl(client, command, { expiresIn: 3600 })

    return {
      thumbnailUrl,
      previewUrl: null,
      expiresIn: 3600,
    }
  },
})

// Delete a video from S3
export const deleteVideo = action({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    // Verify the user owns this video (check key path)
    if (!args.key.includes(`/${userId}/`)) {
      throw new Error('Not authorized to delete this video')
    }

    const client = getS3Client()
    const bucket = getBucket()

    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: args.key,
    })

    await client.send(command)

    return { success: true }
  },
})

// Generate a presigned upload URL for a profile photo
export const getProfilePhotoUploadUrl = action({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const client = getS3Client()
    const bucket = getBucket()

    const timestamp = Date.now()
    const key = `profile-photos/${userId}/${timestamp}.jpg`

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/jpeg' }),
      { expiresIn: 3600 },
    )

    // Generate a download URL for the uploaded photo
    const downloadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 86400 * 7 }, // 7 day URL
    )

    return {
      uploadUrl,
      downloadUrl,
      key,
      expiresIn: 3600,
    }
  },
})

// Generate upload URLs for both HD and SD versions at once
export const getUploadUrls = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const client = getS3Client()
    const bucket = getBucket()

    const timestamp = Date.now()
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_')

    const hdKey = `videos/${userId}/${timestamp}-hd-${sanitizedFilename}`
    const sdKey = `videos/${userId}/${timestamp}-sd-${sanitizedFilename}`
    const thumbnailKey = `thumbnails/${userId}/${timestamp}-thumb.jpg`

    const [hdUrl, sdUrl, thumbnailUrl] = await Promise.all([
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: hdKey, ContentType: args.contentType }),
        { expiresIn: 3600 },
      ),
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: sdKey, ContentType: args.contentType }),
        { expiresIn: 3600 },
      ),
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, ContentType: 'image/jpeg' }),
        { expiresIn: 3600 },
      ),
    ])

    return {
      hdKey,
      hdUrl,
      sdKey,
      sdUrl,
      thumbnailKey,
      thumbnailUrl,
      expiresIn: 3600,
    }
  },
})

export const createPendingMuxVideo = internalMutation({
  args: {
    userId: v.id('users'),
    uploadId: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
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
        storageProvider: 'mux',
        videoStatus: 'waiting_for_upload',
        muxUploadId: args.uploadId,
        muxPlaybackPolicy: args.playbackPolicy,
        muxAssetStatus: 'waiting_for_upload',
        durationMs: args.durationMs,
        width: args.width,
        height: args.height,
        createdAt: now,
      })

      return { recordId, recordType: 'response' as const }
    }

    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      storageProvider: 'mux',
      videoStatus: 'waiting_for_upload',
      muxUploadId: args.uploadId,
      muxPlaybackPolicy: args.playbackPolicy,
      muxAssetStatus: 'waiting_for_upload',
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    return { recordId, recordType: 'bondfire' as const }
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

export const createMuxLiveSessionRecord = internalMutation({
  args: {
    userId: v.id('users'),
    liveStreamId: v.string(),
    playbackId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    return await ctx.db.insert('liveSessions', {
      userId: args.userId,
      muxLiveStreamId: args.liveStreamId,
      muxLivePlaybackId: args.playbackId,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    })
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

    if (args.eventType === 'video.upload.asset_created' && uploadId && assetId) {
      const record = await findMuxRecord(ctx, { uploadId, assetId })
      if (record) {
        await markRecordAssetCreated(ctx, record, { assetId, assetStatus })
      }
      return { handled: true }
    }

    if (args.eventType === 'video.asset.ready' && assetId) {
      const playbackId = getMuxPlaybackId(data)
      const record = await findMuxRecord(ctx, { uploadId, assetId })
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
      return { handled: true }
    }

    if (
      ['video.asset.errored', 'video.upload.cancelled', 'video.upload.timed_out'].includes(
        args.eventType,
      )
    ) {
      const record = await findMuxRecord(ctx, { uploadId, assetId })
      if (record) {
        await markRecordErrored(ctx, record, { assetId, assetStatus })
      }
      return { handled: true }
    }

    if (args.eventType.startsWith('video.live_stream.')) {
      const liveStreamId = readOptionalString(data.id)
      if (!liveStreamId) {
        return { handled: false }
      }

      const liveSession = await ctx.db
        .query('liveSessions')
        .withIndex('by_mux_live_stream', (q) => q.eq('muxLiveStreamId', liveStreamId))
        .first()

      if (!liveSession) {
        return { handled: false }
      }

      const now = Date.now()
      if (args.eventType === 'video.live_stream.active') {
        await ctx.db.patch(liveSession._id, {
          status: 'live',
          startedAt: liveSession.startedAt ?? now,
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.idle') {
        await ctx.db.patch(liveSession._id, {
          status: 'ended',
          endedAt: now,
          updatedAt: now,
        })
      } else if (args.eventType === 'video.live_stream.errored') {
        await ctx.db.patch(liveSession._id, {
          status: 'errored',
          errorMessage: readOptionalString(data.error_message),
          updatedAt: now,
        })
      }

      return { handled: true }
    }

    return { handled: false }
  },
})
