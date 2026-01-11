import * as FileSystem from 'expo-file-system'
import {
  Video,
  getVideoMetaData,
  createVideoThumbnail,
} from 'react-native-compressor'

export interface VideoMetadata {
  width: number
  height: number
  durationMs: number
  size: number
}

export interface ProcessedVideo {
  hdUri: string
  sdUri: string
  thumbnailUri: string
  metadata: VideoMetadata
}

export interface CompressionProgress {
  percentage: number
  stage: 'hd' | 'sd' | 'thumbnail'
}

/**
 * Get video metadata
 */
export async function getVideoMetadata(videoUri: string): Promise<VideoMetadata> {
  try {
    const meta = await getVideoMetaData(videoUri)
    return {
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      durationMs: Math.round((meta.duration ?? 0) * 1000),
      size: meta.size ?? 0,
    }
  } catch {
    // Fallback if metadata extraction fails
    return {
      width: 1280,
      height: 720,
      durationMs: 0,
      size: 0,
    }
  }
}

/**
 * Compress a video to a specific quality preset
 */
async function compressVideo(
  inputUri: string,
  quality: 'high' | 'medium' | 'low',
  onProgress?: (percentage: number) => void,
): Promise<string> {
  const result = await Video.compress(inputUri, {
    compressionMethod: 'auto',
    maxSize: quality === 'high' ? 1280 : 640,
    minimumFileSizeForCompress: 0,
    progressDivider: 10,
  }, (progress: number) => {
    onProgress?.(progress * 100)
  })

  return result
}

/**
 * Extract a thumbnail from a video
 */
async function extractThumbnail(inputUri: string): Promise<string> {
  const result = await createVideoThumbnail(inputUri)
  return result.path
}

/**
 * Process a video: compress to HD/SD and extract thumbnail
 */
export async function processVideo(
  inputUri: string,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<ProcessedVideo> {
  // Get original metadata
  const metadata = await getVideoMetadata(inputUri)

  // Compress to HD (medium compression)
  onProgress?.({ percentage: 0, stage: 'hd' })
  const hdUri = await compressVideo(inputUri, 'high', (pct) => {
    onProgress?.({ percentage: pct * 0.4, stage: 'hd' }) // 0-40%
  })

  // Compress to SD (high compression)
  onProgress?.({ percentage: 40, stage: 'sd' })
  const sdUri = await compressVideo(inputUri, 'medium', (pct) => {
    onProgress?.({ percentage: 40 + pct * 0.4, stage: 'sd' }) // 40-80%
  })

  // Extract thumbnail
  onProgress?.({ percentage: 80, stage: 'thumbnail' })
  const thumbnailUri = await extractThumbnail(inputUri)
  onProgress?.({ percentage: 100, stage: 'thumbnail' })

  // Get compressed file metadata
  const hdInfo = await FileSystem.getInfoAsync(hdUri)

  return {
    hdUri,
    sdUri,
    thumbnailUri,
    metadata: {
      ...metadata,
      size: hdInfo.exists && 'size' in hdInfo ? (hdInfo.size as number) : 0,
    },
  }
}

/**
 * Clean up temporary video files
 */
export async function cleanupTempVideos(uris: string[]): Promise<void> {
  await Promise.all(
    uris.map(async (uri) => {
      try {
        const info = await FileSystem.getInfoAsync(uri)
        if (info.exists) {
          await FileSystem.deleteAsync(uri, { idempotent: true })
        }
      } catch (e) {
        console.error('Failed to delete temp file:', uri, e)
      }
    }),
  )
}

/**
 * Cancel any running compression
 * Note: react-native-compressor handles cancellation internally
 */
export function cancelProcessing(): void {
  // react-native-compressor doesn't expose a cancel API like FFmpeg
  // If needed, implement via AbortController pattern in the caller
}
