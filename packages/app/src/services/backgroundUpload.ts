import {
  cacheDirectory,
  copyAsync,
  getInfoAsync,
  makeDirectoryAsync,
} from 'expo-file-system/legacy'
import * as tus from 'tus-js-client'
import { type UploadTask, uploadQueueActions } from '../store/uploadQueue.store'
import { cleanupTempVideos, type ProcessedVideo, processVideo } from '../utils/videoProcessing'

const MAX_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2 seconds
const COMPLETED_TASK_RETENTION_MS = 30000
const activeTaskIds = new Set<string>()

const PROCESSING_MAX_PROGRESS = 15
const CREDENTIALS_READY_PROGRESS = 20
const UPLOAD_END_PROGRESS = 97
const COMPLETE_PROGRESS = 100
type TusUploadOptions = ConstructorParameters<typeof tus.Upload>[1]
type ReactNativeTusFile = {
  uri: string
  name: string
  type: string
}
type ReactNativeTusUploadConstructor = new (
  file: ReactNativeTusFile,
  options: TusUploadOptions,
) => tus.Upload
const ReactNativeTusUpload = tus.Upload as ReactNativeTusUploadConstructor

export interface BackgroundUploadCallbacks {
  onProgress?: (progress: number, stage: string) => void
  onComplete?: () => void
  onError?: (error: Error) => void
}

export interface BackgroundUploadOptions {
  videoUri: string // Original video URI from camera
  bondfireId?: string // If responding to existing bondfire
  isResponse: boolean
  getBunnyUploadCredentials: (args: { filename: string; contentType: string }) => Promise<{
    videoId: string
    libraryId: string
    endpoint: string
    authorizationSignature: string
    authorizationExpire: number
    headers: {
      AuthorizationSignature: string
      AuthorizationExpire: string
      LibraryId: string
      VideoId: string
    }
    metadata: {
      filetype: string
      title: string
    }
  }>
  createBondfire: (args: {
    storageProvider: 'bunny'
    bunnyVideoId: string
    bunnyLibraryId: string
    durationMs: number
    width: number
    height: number
  }) => Promise<void>
  addResponse: (args: {
    bondfireId: string
    storageProvider: 'bunny'
    bunnyVideoId: string
    bunnyLibraryId: string
    durationMs: number
    width: number
    height: number
  }) => Promise<void>
  callbacks?: BackgroundUploadCallbacks
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)))
}

function stageLabel(stage: 'metadata' | 'ready'): string {
  switch (stage) {
    case 'metadata':
      return 'Reading video metadata...'
    case 'ready':
      return 'Video ready to upload...'
    default:
      return 'Preparing video...'
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

function hasPreparedUpload(
  video: UploadTask['processedVideo'] | undefined,
): video is ProcessedVideo {
  return !!video && typeof video.uploadUri === 'string'
}

async function uploadBunnyTusWithProgress(params: {
  upload: NonNullable<UploadTask['bunnyUpload']>
  fileUri: string
  contentType: string
  filename: string
  onProgress: (fractionComplete: number) => void
}): Promise<void> {
  const fileInfo = await getInfoAsync(params.fileUri)
  if (!fileInfo.exists) {
    throw new Error(`Video file not found: ${params.fileUri}`)
  }

  const uploadSize = typeof fileInfo.size === 'number' ? fileInfo.size : undefined
  const file: ReactNativeTusFile = {
    uri: params.fileUri,
    name: params.filename,
    type: params.contentType,
  }

  await new Promise<void>((resolve, reject) => {
    let lastFraction = -1

    const upload = new ReactNativeTusUpload(file, {
      endpoint: params.upload.endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000, 60000],
      headers: params.upload.headers,
      metadata: params.upload.metadata,
      uploadSize,
      onProgress: (bytesUploaded, bytesTotal) => {
        const fraction = bytesTotal > 0 ? bytesUploaded / bytesTotal : bytesUploaded > 0 ? 1 : 0
        const normalizedFraction = Math.max(0, Math.min(1, fraction))

        if (Math.abs(normalizedFraction - lastFraction) >= 0.01 || normalizedFraction === 1) {
          lastFraction = normalizedFraction
          params.onProgress(normalizedFraction)
        }
      },
      onError: (error) => {
        reject(error)
      },
      onSuccess: () => {
        params.onProgress(1)
        resolve()
      },
    })

    upload.start()
  })
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
export async function startBackgroundUpload(
  options: BackgroundUploadOptions,
  autoStart = true,
): Promise<string> {
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

  if (autoStart) {
    // Start processing (don't await - let it run in background)
    processUploadTask(taskId, options).catch((error) => {
      console.error('[backgroundUpload] Task failed:', error)
      options.callbacks?.onError?.(error)
    })
  }

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
  if (task.status === 'completed' || task.status === 'failed' || activeTaskIds.has(taskId)) {
    return
  }

  let attemptCount = task.attemptCount
  activeTaskIds.add(taskId)

  try {
    // Step 1: Process video if not already processed
    let processed: ProcessedVideo

    uploadQueueActions.updateTask(taskId, {
      status: 'processing',
      errorMessage: undefined,
    })

    if (hasPreparedUpload(task.processedVideo)) {
      processed = task.processedVideo
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

    // Step 2: Create Bunny video and get signed TUS credentials if not already obtained
    let bunnyUpload = task.bunnyUpload
    const filename = `bondfire-${Date.now()}.mp4`
    if (!bunnyUpload) {
      setTaskProgress(taskId, options, PROCESSING_MAX_PROGRESS, 'Creating Bunny upload...')
      bunnyUpload = await options.getBunnyUploadCredentials({
        filename,
        contentType: 'video/mp4',
      })

      uploadQueueActions.updateTask(taskId, {
        bunnyUpload,
      })
    }

    setTaskProgress(taskId, options, CREDENTIALS_READY_PROGRESS, 'Upload ready')

    // Step 3: Upload original video to Bunny Stream with TUS progress
    uploadQueueActions.updateTask(taskId, { status: 'uploading' })

    const uploadRange = UPLOAD_END_PROGRESS - CREDENTIALS_READY_PROGRESS
    await uploadBunnyTusWithProgress({
      upload: bunnyUpload,
      fileUri: processed.uploadUri,
      contentType: 'video/mp4',
      filename,
      onProgress: (fraction) => {
        setTaskProgress(
          taskId,
          options,
          CREDENTIALS_READY_PROGRESS + uploadRange * fraction,
          'Uploading video...',
        )
      },
    })

    // Step 4: Create bondfire or response
    setTaskProgress(
      taskId,
      options,
      UPLOAD_END_PROGRESS,
      options.isResponse ? 'Publishing response...' : 'Publishing bondfire...',
    )

    if (options.isResponse && options.bondfireId) {
      await options.addResponse({
        bondfireId: options.bondfireId,
        storageProvider: 'bunny',
        bunnyVideoId: bunnyUpload.videoId,
        bunnyLibraryId: bunnyUpload.libraryId,
        durationMs: processed.metadata.durationMs,
        width: processed.metadata.width,
        height: processed.metadata.height,
      })
    } else {
      await options.createBondfire({
        storageProvider: 'bunny',
        bunnyVideoId: bunnyUpload.videoId,
        bunnyLibraryId: bunnyUpload.libraryId,
        durationMs: processed.metadata.durationMs,
        width: processed.metadata.width,
        height: processed.metadata.height,
      })
    }

    // Step 5: Cleanup
    await cleanupTempVideos([processed.uploadUri])

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
  } finally {
    activeTaskIds.delete(taskId)
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
