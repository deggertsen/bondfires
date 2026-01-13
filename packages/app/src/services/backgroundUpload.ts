import {
  cacheDirectory,
  copyAsync,
  getInfoAsync,
  makeDirectoryAsync,
} from 'expo-file-system/legacy'
import { type UploadTask, uploadQueueActions } from '../store/uploadQueue.store'
import { type ProcessedVideo, processVideo } from '../utils/videoProcessing'
import { cleanupTempVideos } from '../utils/videoProcessing'

const MAX_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2 seconds

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
    attemptCount: 0,
    createdAt: Date.now(),
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
    if (task.processedVideo) {
      processed = task.processedVideo as ProcessedVideo
      uploadQueueActions.updateTask(taskId, { status: 'processing' })
    } else {
      uploadQueueActions.updateTask(taskId, { status: 'processing' })
      options.callbacks?.onProgress?.(0, 'Processing video...')

      processed = await processVideo(task.videoFilePath, (progress) => {
        options.callbacks?.onProgress?.(progress.percentage * 0.4, progress.stage)
      })

      uploadQueueActions.updateTask(taskId, {
        processedVideo: processed,
      })
    }

    // Step 2: Get presigned URLs if not already obtained
    let presignedUrls = task.presignedUrls
    if (!presignedUrls) {
      options.callbacks?.onProgress?.(40, 'Getting upload URLs...')
      const filename = `bondfire-${Date.now()}.mp4`
      presignedUrls = await options.getUploadUrls({
        filename,
        contentType: 'video/mp4',
      })

      uploadQueueActions.updateTask(taskId, {
        presignedUrls,
      })
    }

    // Step 3: Upload files
    uploadQueueActions.updateTask(taskId, { status: 'uploading' })
    options.callbacks?.onProgress?.(50, 'Uploading HD video...')

    // Upload HD video
    const hdFile = await fetch(processed.hdUri)
    const hdBlob = await hdFile.blob()
    await fetch(presignedUrls.hdUrl, {
      method: 'PUT',
      body: hdBlob,
      headers: { 'Content-Type': 'video/mp4' },
    })

    options.callbacks?.onProgress?.(70, 'Uploading SD video...')

    // Upload SD video
    const sdFile = await fetch(processed.sdUri)
    const sdBlob = await sdFile.blob()
    await fetch(presignedUrls.sdUrl, {
      method: 'PUT',
      body: sdBlob,
      headers: { 'Content-Type': 'video/mp4' },
    })

    options.callbacks?.onProgress?.(85, 'Uploading thumbnail...')

    // Upload thumbnail
    const thumbFile = await fetch(processed.thumbnailUri)
    const thumbBlob = await thumbFile.blob()
    await fetch(presignedUrls.thumbnailUrl, {
      method: 'PUT',
      body: thumbBlob,
      headers: { 'Content-Type': 'image/jpeg' },
    })

    // Step 4: Create bondfire or response
    options.callbacks?.onProgress?.(90, 'Creating bondfire...')

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

    // Mark as completed
    uploadQueueActions.updateTask(taskId, {
      status: 'completed',
      lastAttemptAt: Date.now(),
    })

    options.callbacks?.onProgress?.(100, 'Complete!')
    options.callbacks?.onComplete?.()

    // Remove completed task after a delay
    setTimeout(() => {
      uploadQueueActions.removeTask(taskId)
    }, 5000)
  } catch (error) {
    console.error('[backgroundUpload] Upload error:', error)
    attemptCount++

    if (attemptCount < MAX_RETRIES) {
      // Retry with exponential backoff
      const retryDelay = BASE_RETRY_DELAY * 2 ** (attemptCount - 1)

      uploadQueueActions.updateTask(taskId, {
        status: 'pending',
        attemptCount,
        lastAttemptAt: Date.now(),
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
      })
      options.callbacks?.onError?.(error as Error)
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
