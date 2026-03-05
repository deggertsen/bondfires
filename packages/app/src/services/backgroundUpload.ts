import {
  cacheDirectory,
  copyAsync,
  createUploadTask,
  getInfoAsync,
  makeDirectoryAsync,
  FileSystemUploadType,
} from 'expo-file-system/legacy'
import { type UploadTask, uploadQueueActions } from '../store/uploadQueue.store'
import { cleanupTempVideos, type ProcessedVideo, processVideo } from '../utils/videoProcessing'

const MAX_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2 seconds
const COMPLETED_TASK_RETENTION_MS = 30000

const PROCESSING_MAX_PROGRESS = 40
const URLS_READY_PROGRESS = 45
const HD_UPLOAD_END_PROGRESS = 75
const SD_UPLOAD_END_PROGRESS = 90
const THUMB_UPLOAD_END_PROGRESS = 97
const COMPLETE_PROGRESS = 100

export interface BackgroundUploadCallbacks {
  onProgress?: (progress: number, stage: string) => void
  onComplete?: () => void
  onError?: (error: Error) => void
}

export interface BackgroundUploadOptions {
  videoUri: string // Original video URI from camera
  bondfireId?: string // If responding to existing bondfire
  isResponse: boolean
  getUploadUrls: (args: { filename: string; contentType: string }) => Promise<{
    hdUrl: string
    sdUrl: string
    thumbnailUrl: string
    hdKey: string
    sdKey: string
    thumbnailKey: string
  }>
  createBondfire: (args: {
    videoKey: string
    sdVideoKey: string
    thumbnailKey: string
    durationMs: number
    width: number
    height: number
  }) => Promise<void>
  addResponse: (args: {
    bondfireId: string
    videoKey: string
    sdVideoKey: string
    thumbnailKey: string
    durationMs: number
    width: number
    height: number
  }) => Promise<void>
  callbacks?: BackgroundUploadCallbacks
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)))
}

function stageLabel(stage: 'hd' | 'sd' | 'thumbnail'): string {
  switch (stage) {
    case 'hd':
      return 'Processing HD video...'
    case 'sd':
      return 'Processing SD video...'
    case 'thumbnail':
      return 'Generating thumbnail...'
    default:
      return 'Processing video...'
  }
}

function setTaskProgress(
  taskId: string,
  options: BackgroundUploadOptions,
  progress: number,
  stage: string,
): void {
  const normalizedProgress = clampProgress(progress)
  const task = uploadQueueActions.getTask(taskId)

  if (task?.progress === normalizedProgress && task.stage === stage) {
    return
  }

  uploadQueueActions.updateTask(taskId, {
    progress: normalizedProgress,
    stage,
  })

  options.callbacks?.onProgress?.(normalizedProgress, stage)
}

async function uploadFileWithProgress(params: {
  url: string
  fileUri: string
  contentType: string
  onProgress: (fractionComplete: number) => void
}): Promise<void> {
  let lastFraction = -1

  const uploadTask = createUploadTask(
    params.url,
    params.fileUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': params.contentType },
    },
    (progress) => {
      const expectedBytes = progress.totalBytesExpectedToSend
      const fraction =
        expectedBytes > 0 ? progress.totalBytesSent / expectedBytes : progress.totalBytesSent > 0 ? 1 : 0
      const normalizedFraction = Math.max(0, Math.min(1, fraction))

      // Only update when progress has materially moved (or completes) to avoid noisy re-renders.
      if (Math.abs(normalizedFraction - lastFraction) >= 0.01 || normalizedFraction === 1) {
        lastFraction = normalizedFraction
        params.onProgress(normalizedFraction)
      }
    },
  )

  const response = await uploadTask.uploadAsync()
  if (!response) {
    throw new Error('Upload was cancelled before completion')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to upload file: ${response.status}`)
  }

  params.onProgress(1)
}

/**
 * Copy video file to persistent storage
 */
async function copyToPersistentStorage(uri: string): Promise<string> {
  const fileInfo = await getInfoAsync(uri)
  if (!fileInfo.exists) {
    throw new Error(`Video file not found: ${uri}`)
  }

  // Get cache directory and create persistent path
  if (!cacheDirectory) {
    throw new Error('Cache directory not available')
  }

  const persistentDir = `${cacheDirectory}uploads/`
  const persistentPath = `${persistentDir}${Date.now()}-${Math.random().toString(36).substring(7)}.mp4`

  // Ensure directory exists
  const dirInfo = await getInfoAsync(persistentDir)
  if (!dirInfo.exists) {
    await makeDirectoryAsync(persistentDir, { intermediates: true })
  }

  // Copy file to persistent storage
  await copyAsync({
    from: uri,
    to: persistentPath,
  })

  return persistentPath
}

/**
 * Process and upload video in the background
 */
export async function startBackgroundUpload(options: BackgroundUploadOptions): Promise<string> {
  const taskId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`

  // Copy video to persistent storage
  const persistentPath = await copyToPersistentStorage(options.videoUri)

  // Create upload task
  const task: UploadTask = {
    id: taskId,
    videoFilePath: persistentPath,
    bondfireId: options.bondfireId,
    isResponse: options.isResponse,
    status: 'pending',
    progress: 0,
    stage: 'Queued',
    attemptCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  uploadQueueActions.addTask(task)

  // Start processing (don't await - let it run in background)
  processUploadTask(taskId, options).catch((error) => {
    console.error('[backgroundUpload] Task failed:', error)
    options.callbacks?.onError?.(error)
  })

  return taskId
}

/**
 * Process a single upload task
 */
async function processUploadTask(taskId: string, options: BackgroundUploadOptions): Promise<void> {
  const task = uploadQueueActions.getTask(taskId)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }

  let attemptCount = task.attemptCount

  try {
    // Step 1: Process video if not already processed
    let processed: ProcessedVideo

    uploadQueueActions.updateTask(taskId, {
      status: 'processing',
      errorMessage: undefined,
    })

    if (task.processedVideo) {
      processed = task.processedVideo as ProcessedVideo
      setTaskProgress(taskId, options, PROCESSING_MAX_PROGRESS, 'Video already processed')
    } else {
      setTaskProgress(taskId, options, 0, 'Processing video...')

      processed = await processVideo(task.videoFilePath, (progress) => {
        const normalized = (progress.percentage / 100) * PROCESSING_MAX_PROGRESS
        setTaskProgress(taskId, options, normalized, stageLabel(progress.stage))
      })

      uploadQueueActions.updateTask(taskId, {
        processedVideo: processed,
      })

      setTaskProgress(taskId, options, PROCESSING_MAX_PROGRESS, 'Video processing complete')
    }

    // Step 2: Get presigned URLs if not already obtained
    let presignedUrls = task.presignedUrls
    if (!presignedUrls) {
      setTaskProgress(taskId, options, PROCESSING_MAX_PROGRESS, 'Getting upload URLs...')
      const filename = `bondfire-${Date.now()}.mp4`
      presignedUrls = await options.getUploadUrls({
        filename,
        contentType: 'video/mp4',
      })

      uploadQueueActions.updateTask(taskId, {
        presignedUrls,
      })
    }

    setTaskProgress(taskId, options, URLS_READY_PROGRESS, 'Upload URLs ready')

    // Step 3: Upload files with byte-level progress
    uploadQueueActions.updateTask(taskId, { status: 'uploading' })

    const hdStart = URLS_READY_PROGRESS
    const hdRange = HD_UPLOAD_END_PROGRESS - hdStart
    await uploadFileWithProgress({
      url: presignedUrls.hdUrl,
      fileUri: processed.hdUri,
      contentType: 'video/mp4',
      onProgress: (fraction) => {
        setTaskProgress(taskId, options, hdStart + hdRange * fraction, 'Uploading HD video...')
      },
    })

    const sdStart = HD_UPLOAD_END_PROGRESS
    const sdRange = SD_UPLOAD_END_PROGRESS - sdStart
    await uploadFileWithProgress({
      url: presignedUrls.sdUrl,
      fileUri: processed.sdUri,
      contentType: 'video/mp4',
      onProgress: (fraction) => {
        setTaskProgress(taskId, options, sdStart + sdRange * fraction, 'Uploading SD video...')
      },
    })

    const thumbStart = SD_UPLOAD_END_PROGRESS
    const thumbRange = THUMB_UPLOAD_END_PROGRESS - thumbStart
    await uploadFileWithProgress({
      url: presignedUrls.thumbnailUrl,
      fileUri: processed.thumbnailUri,
      contentType: 'image/jpeg',
      onProgress: (fraction) => {
        setTaskProgress(taskId, options, thumbStart + thumbRange * fraction, 'Uploading thumbnail...')
      },
    })

    // Step 4: Create bondfire or response
    setTaskProgress(
      taskId,
      options,
      THUMB_UPLOAD_END_PROGRESS,
      options.isResponse ? 'Publishing response...' : 'Publishing bondfire...',
    )

    if (options.isResponse && options.bondfireId) {
      await options.addResponse({
        bondfireId: options.bondfireId,
        videoKey: presignedUrls.hdKey,
        sdVideoKey: presignedUrls.sdKey,
        thumbnailKey: presignedUrls.thumbnailKey,
        durationMs: processed.metadata.durationMs,
        width: processed.metadata.width,
        height: processed.metadata.height,
      })
    } else {
      await options.createBondfire({
        videoKey: presignedUrls.hdKey,
        sdVideoKey: presignedUrls.sdKey,
        thumbnailKey: presignedUrls.thumbnailKey,
        durationMs: processed.metadata.durationMs,
        width: processed.metadata.width,
        height: processed.metadata.height,
      })
    }

    // Step 5: Cleanup
    await cleanupTempVideos([processed.hdUri, processed.sdUri, processed.thumbnailUri])

    const completedAt = Date.now()
    uploadQueueActions.updateTask(taskId, {
      status: 'completed',
      progress: COMPLETE_PROGRESS,
      stage: 'Complete!',
      errorMessage: undefined,
      completedAt,
      lastAttemptAt: completedAt,
    })

    options.callbacks?.onProgress?.(COMPLETE_PROGRESS, 'Complete!')
    options.callbacks?.onComplete?.()

    // Keep the completed task visible briefly so users can confirm completion.
    setTimeout(() => {
      uploadQueueActions.removeTask(taskId)
    }, COMPLETED_TASK_RETENTION_MS)
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Upload failed')
    console.error('[backgroundUpload] Upload error:', normalizedError)
    attemptCount++

    if (attemptCount < MAX_RETRIES) {
      // Retry with exponential backoff
      const retryDelay = BASE_RETRY_DELAY * 2 ** (attemptCount - 1)
      const retryInSeconds = Math.max(1, Math.round(retryDelay / 1000))

      uploadQueueActions.updateTask(taskId, {
        status: 'pending',
        attemptCount,
        lastAttemptAt: Date.now(),
        errorMessage: normalizedError.message,
        stage: `Retrying in ${retryInSeconds}s (${attemptCount + 1}/${MAX_RETRIES})`,
      })

      setTimeout(() => {
        processUploadTask(taskId, options).catch((err) => {
          console.error('[backgroundUpload] Retry failed:', err)
        })
      }, retryDelay)
    } else {
      // Max retries reached
      uploadQueueActions.updateTask(taskId, {
        status: 'failed',
        attemptCount,
        lastAttemptAt: Date.now(),
        errorMessage: normalizedError.message,
        stage: 'Upload failed',
      })
      options.callbacks?.onError?.(normalizedError)
    }
  }
}

/**
 * Resume pending uploads on app startup
 */
export async function resumePendingUploads(
  options: Omit<BackgroundUploadOptions, 'videoUri'>,
): Promise<void> {
  const pendingTasks = uploadQueueActions.getPendingTasks()

  for (const task of pendingTasks) {
    // Reconstruct options with the task's video URI
    const taskOptions: BackgroundUploadOptions = {
      ...options,
      videoUri: task.videoFilePath,
      bondfireId: task.bondfireId,
      isResponse: task.isResponse,
    }

    // Resume processing
    processUploadTask(task.id, taskOptions).catch((error) => {
      console.error(`[backgroundUpload] Failed to resume task ${task.id}:`, error)
    })
  }
}
