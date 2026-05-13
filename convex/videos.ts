import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v } from 'convex/values'
import { action } from './_generated/server'
import { auth } from './auth'

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

const BUNNY_TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload'
const DEFAULT_BUNNY_UPLOAD_EXPIRES_IN_SECONDS = 24 * 60 * 60
const DEFAULT_BUNNY_LOW_RESOLUTION = '360'

interface BunnyStreamConfig {
  apiKey: string
  libraryId: string
  cdnBaseUrl: string
  collectionId?: string
  lowResolution: string
}

interface BunnyCreateVideoResponse {
  guid: string
}

function normalizeCdnBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }

  return `https://${trimmed}`
}

function getBunnyStreamConfig(): BunnyStreamConfig {
  const apiKey = process.env.BUNNY_STREAM_API_KEY
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID
  const cdnBaseUrl =
    process.env.BUNNY_STREAM_CDN_BASE_URL ??
    process.env.BUNNY_STREAM_PULL_ZONE_URL ??
    process.env.BUNNY_STREAM_CDN_HOSTNAME

  if (!apiKey || !libraryId || !cdnBaseUrl) {
    throw new Error(
      'Bunny Stream is not configured. Please set BUNNY_STREAM_API_KEY, BUNNY_STREAM_LIBRARY_ID, and BUNNY_STREAM_CDN_BASE_URL in Convex environment variables.',
    )
  }

  return {
    apiKey,
    libraryId,
    cdnBaseUrl: normalizeCdnBaseUrl(cdnBaseUrl),
    collectionId: process.env.BUNNY_STREAM_COLLECTION_ID,
    lowResolution: process.env.BUNNY_STREAM_LOW_RESOLUTION ?? DEFAULT_BUNNY_LOW_RESOLUTION,
  }
}

function getOptionalBunnyConfigForPlayback(libraryId?: string): Omit<BunnyStreamConfig, 'apiKey'> {
  const configuredLibraryId = process.env.BUNNY_STREAM_LIBRARY_ID
  const cdnBaseUrl =
    process.env.BUNNY_STREAM_CDN_BASE_URL ??
    process.env.BUNNY_STREAM_PULL_ZONE_URL ??
    process.env.BUNNY_STREAM_CDN_HOSTNAME

  if (!cdnBaseUrl) {
    throw new Error(
      'BUNNY_STREAM_CDN_BASE_URL not configured in Convex environment variables. It is required to resolve Bunny Stream playback URLs.',
    )
  }

  return {
    libraryId: libraryId ?? configuredLibraryId ?? '',
    cdnBaseUrl: normalizeCdnBaseUrl(cdnBaseUrl),
    collectionId: process.env.BUNNY_STREAM_COLLECTION_ID,
    lowResolution: process.env.BUNNY_STREAM_LOW_RESOLUTION ?? DEFAULT_BUNNY_LOW_RESOLUTION,
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Unexpected Bunny Stream API response')
  }

  return value as Record<string, unknown>
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Bunny Stream API response is missing ${fieldName}`)
  }

  return value
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function getBunnyUrls(videoId: string, libraryId?: string) {
  const config = getOptionalBunnyConfigForPlayback(libraryId)
  const videoBaseUrl = `${config.cdnBaseUrl}/${videoId}`

  return {
    libraryId: config.libraryId,
    hdUrl: `${videoBaseUrl}/playlist.m3u8`,
    sdUrl: `${videoBaseUrl}/play_${config.lowResolution}p.mp4`,
    thumbnailUrl: `${videoBaseUrl}/thumbnail.jpg`,
    previewUrl: `${videoBaseUrl}/preview.webp`,
  }
}

async function createBunnyVideo(args: {
  title: string
  thumbnailTimeMs?: number
}): Promise<BunnyCreateVideoResponse> {
  const config = getBunnyStreamConfig()
  const requestBody: {
    title: string
    collectionId?: string
    thumbnailTime?: number
  } = {
    title: args.title,
  }

  if (config.collectionId) {
    requestBody.collectionId = config.collectionId
  }

  if (args.thumbnailTimeMs !== undefined) {
    requestBody.thumbnailTime = args.thumbnailTimeMs
  }

  const response = await fetch(`https://video.bunnycdn.com/library/${config.libraryId}/videos`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      AccessKey: config.apiKey,
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Failed to create Bunny Stream video: ${response.status} ${message}`)
  }

  const payload: unknown = await response.json()
  const object = readObject(payload)

  return {
    guid: readString(object.guid, 'guid'),
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

export const getBunnyUploadCredentials = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const config = getBunnyStreamConfig()
    const title = args.title?.trim() || args.filename
    const thumbnailTimeMs = Number(process.env.BUNNY_STREAM_THUMBNAIL_TIME_MS ?? 1000)
    const video = await createBunnyVideo({
      title,
      thumbnailTimeMs: Number.isFinite(thumbnailTimeMs) ? thumbnailTimeMs : undefined,
    })

    const authorizationExpire =
      Math.floor(Date.now() / 1000) + DEFAULT_BUNNY_UPLOAD_EXPIRES_IN_SECONDS
    const authorizationSignature = await sha256Hex(
      `${config.libraryId}${config.apiKey}${authorizationExpire}${video.guid}`,
    )
    const urls = getBunnyUrls(video.guid, config.libraryId)

    return {
      storageProvider: 'bunny',
      videoId: video.guid,
      libraryId: config.libraryId,
      endpoint: BUNNY_TUS_ENDPOINT,
      authorizationSignature,
      authorizationExpire,
      headers: {
        AuthorizationSignature: authorizationSignature,
        AuthorizationExpire: authorizationExpire.toString(),
        LibraryId: config.libraryId,
        VideoId: video.guid,
      },
      metadata: {
        filetype: args.contentType,
        title,
      },
      playbackUrl: urls.hdUrl,
      lowBandwidthUrl: urls.sdUrl,
      thumbnailUrl: urls.thumbnailUrl,
      expiresIn: DEFAULT_BUNNY_UPLOAD_EXPIRES_IN_SECONDS,
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

// Generate presigned URLs for both HD and SD versions
export const getVideoUrls = action({
  args: {
    hdKey: v.optional(v.string()),
    sdKey: v.optional(v.string()),
    bunnyVideoId: v.optional(v.string()),
    bunnyLibraryId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    if (args.bunnyVideoId) {
      const urls = getBunnyUrls(args.bunnyVideoId, args.bunnyLibraryId)
      return {
        hdUrl: urls.hdUrl,
        sdUrl: urls.sdUrl,
        thumbnailUrl: urls.thumbnailUrl,
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
    bunnyVideoId: v.optional(v.string()),
    bunnyLibraryId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    if (args.bunnyVideoId) {
      const urls = getBunnyUrls(args.bunnyVideoId, args.bunnyLibraryId)
      return {
        thumbnailUrl: urls.thumbnailUrl,
        previewUrl: urls.previewUrl,
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
