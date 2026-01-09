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
    hdKey: v.string(),
    sdKey: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
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
