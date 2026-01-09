import * as FileSystem from 'expo-file-system'
import { FFmpegKit, FFmpegKitConfig, ReturnCode } from 'ffmpeg-kit-react-native'

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

// Video quality presets
const QUALITY_PRESETS = {
  hd: {
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: '2500k',
    audioBitrate: '128k',
  },
  sd: {
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: '800k',
    audioBitrate: '96k',
  },
}

/**
 * Get video metadata using FFprobe
 */
export async function getVideoMetadata(videoUri: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    FFmpegKitConfig.enableStatisticsCallback(() => {})

    FFmpegKit.executeAsync(
      `-i "${videoUri}" -v quiet -print_format json -show_format -show_streams`,
      async (session) => {
        const returnCode = await session.getReturnCode()
        const output = await session.getOutput()

        if (ReturnCode.isSuccess(returnCode)) {
          try {
            const data = JSON.parse(output)
            const videoStream = data.streams?.find(
              (s: { codec_type?: string; width?: number; height?: number }) =>
                s.codec_type === 'video',
            )

            resolve({
              width: videoStream?.width ?? 0,
              height: videoStream?.height ?? 0,
              durationMs: Math.round((Number.parseFloat(data.format?.duration) || 0) * 1000),
              size: Number.parseInt(data.format?.size) || 0,
            })
          } catch {
            // Fallback if parsing fails
            resolve({
              width: 1280,
              height: 720,
              durationMs: 0,
              size: 0,
            })
          }
        } else {
          reject(new Error('Failed to get video metadata'))
        }
      },
    )
  })
}

/**
 * Compress a video to a specific quality preset
 */
async function compressVideo(
  inputUri: string,
  outputUri: string,
  preset: 'hd' | 'sd',
  onProgress?: (percentage: number) => void,
): Promise<string> {
  const { maxWidth, maxHeight, videoBitrate, audioBitrate } = QUALITY_PRESETS[preset]

  // Scale filter that maintains aspect ratio and fits within max dimensions
  const scaleFilter = `scale='min(${maxWidth},iw)':min'(${maxHeight},ih)':force_original_aspect_ratio=decrease`

  const command = [
    `-i "${inputUri}"`,
    `-vf "${scaleFilter}"`,
    '-c:v libx264',
    '-preset fast',
    '-crf 23',
    `-b:v ${videoBitrate}`,
    '-c:a aac',
    `-b:a ${audioBitrate}`,
    '-movflags +faststart', // Enable fast start for streaming
    '-y', // Overwrite output
    `"${outputUri}"`,
  ].join(' ')

  return new Promise((resolve, reject) => {
    FFmpegKitConfig.enableStatisticsCallback((statistics) => {
      if (onProgress) {
        // Calculate progress based on time
        const time = statistics.getTime()
        // This is approximate - we'd need the total duration for accurate progress
        onProgress(Math.min((time / 60000) * 100, 99))
      }
    })

    FFmpegKit.executeAsync(command, async (session) => {
      const returnCode = await session.getReturnCode()

      if (ReturnCode.isSuccess(returnCode)) {
        resolve(outputUri)
      } else if (ReturnCode.isCancel(returnCode)) {
        reject(new Error('Video compression cancelled'))
      } else {
        const logs = await session.getAllLogsAsString()
        reject(new Error(`Video compression failed: ${logs}`))
      }
    })
  })
}

/**
 * Extract a thumbnail from a video
 */
async function extractThumbnail(
  inputUri: string,
  outputUri: string,
  timeSeconds = 1,
): Promise<string> {
  const command = [
    `-i "${inputUri}"`,
    `-ss ${timeSeconds}`,
    '-vframes 1',
    '-vf "scale=640:-1"',
    '-q:v 2',
    '-y',
    `"${outputUri}"`,
  ].join(' ')

  return new Promise((resolve, reject) => {
    FFmpegKit.executeAsync(command, async (session) => {
      const returnCode = await session.getReturnCode()

      if (ReturnCode.isSuccess(returnCode)) {
        resolve(outputUri)
      } else {
        reject(new Error('Failed to extract thumbnail'))
      }
    })
  })
}

/**
 * Process a video: compress to HD/SD and extract thumbnail
 */
export async function processVideo(
  inputUri: string,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<ProcessedVideo> {
  // Get cache directory - use documentDirectory as fallback
  const cacheDir =
    (FileSystem as { cacheDirectory?: string | null }).cacheDirectory ??
    (FileSystem as { documentDirectory?: string | null }).documentDirectory
  if (!cacheDir) {
    throw new Error('Cache directory not available')
  }

  const timestamp = Date.now()
  const hdOutputUri = `${cacheDir}video_${timestamp}_hd.mp4`
  const sdOutputUri = `${cacheDir}video_${timestamp}_sd.mp4`
  const thumbnailUri = `${cacheDir}video_${timestamp}_thumb.jpg`

  // Get original metadata
  const metadata = await getVideoMetadata(inputUri)

  // Compress to HD
  onProgress?.({ percentage: 0, stage: 'hd' })
  await compressVideo(inputUri, hdOutputUri, 'hd', (pct) => {
    onProgress?.({ percentage: pct * 0.4, stage: 'hd' }) // 0-40%
  })

  // Compress to SD
  onProgress?.({ percentage: 40, stage: 'sd' })
  await compressVideo(inputUri, sdOutputUri, 'sd', (pct) => {
    onProgress?.({ percentage: 40 + pct * 0.4, stage: 'sd' }) // 40-80%
  })

  // Extract thumbnail
  onProgress?.({ percentage: 80, stage: 'thumbnail' })
  await extractThumbnail(inputUri, thumbnailUri)
  onProgress?.({ percentage: 100, stage: 'thumbnail' })

  // Get compressed file metadata
  const hdInfo = await FileSystem.getInfoAsync(hdOutputUri)

  return {
    hdUri: hdOutputUri,
    sdUri: sdOutputUri,
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
        console.warn(`Failed to delete temp file: ${uri}`, e)
      }
    }),
  )
}

/**
 * Cancel any running FFmpeg sessions
 */
export function cancelProcessing(): void {
  FFmpegKit.cancel()
}
