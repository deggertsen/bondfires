import { File } from 'expo-file-system'
import { getVideoMetaData } from 'react-native-compressor'

export interface VideoMetadata {
  width: number
  height: number
  durationMs: number
  size: number
}

export interface ProcessedVideo {
  uploadUri: string
  metadata: VideoMetadata
}

export interface CompressionProgress {
  percentage: number
  stage: 'metadata' | 'ready'
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
 * Prepare a video for Bunny Stream upload. Bunny handles transcoding and thumbnails.
 */
export async function processVideo(
  inputUri: string,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<ProcessedVideo> {
  onProgress?.({ percentage: 0, stage: 'metadata' })
  const metadata = await getVideoMetadata(inputUri)
  onProgress?.({ percentage: 100, stage: 'ready' })

  const uploadFile = new File(inputUri)
  const uploadSize = uploadFile.exists ? (uploadFile.size ?? metadata.size) : metadata.size

  return {
    uploadUri: inputUri,
    metadata: {
      ...metadata,
      size: uploadSize,
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
        const file = new File(uri)
        if (file.exists) {
          file.delete()
        }
      } catch (e) {
        console.error('Failed to delete temp file:', uri, e)
      }
    }),
  )
}

/**
 * Cancel in-flight preparation work if a cancellable processor is added later.
 */
export function cancelProcessing(): void {
  // Metadata extraction does not expose cancellation.
}
