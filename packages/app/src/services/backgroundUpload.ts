import {
  cacheDirectory,
  copyAsync,
  createUploadTask,
  FileSystemUploadType,
  getInfoAsync,
  makeDirectoryAsync,
} from 'expo-file-system/legacy'
import { type UploadTask, uploadQueueActions } from '../store/uploadQueue.store'
import { cleanupTempVideos, type ProcessedVideo, processVideo } from '../utils/videoProcessing'
import { telemetry } from './telemetry'

const MAX_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2 seconds
const COMPLETED_TASK_RETENTION_MS = 30000
const activeTaskIds = new Set<string>()

const PROCESSING_MAX_PROGRESS = 15
const CREDENTIALS_READY_PROGRESS = 20
const UPLOAD_END_PROGRESS = 97
const MUX_READY_PROGRESS = 99
const COMPLETE_PROGRESS = 100
const MUX_READY_POLL_INTERVAL_MS = 5000
const MUX_READY_TIMEOUT_MS = 10 * 60 * 1000

interface MuxUploadStatus {
  uploadStatus: string
  assetStatus?: string
  assetId?: string
  playbackId?: string
  isReady: boolean
  isFailed: boolean
}

interface MuxDirectUpload {
  uploadId: string
  uploadUrl: string
  recordId: string
  recordType: 'bondfire' | 'response'
  expiresIn?: number
}

interface UploadFileInfo {
  filename: string
  contentType: string
}

export interface BackgroundUploadCallbacks {
  onProgress?: (progress: number, stage: string) => void
  onComplete?: () => void
  onError?: (error: Error) => void
}

export interface BackgroundUploadOptions {
  videoUri: string // Original video URI from camera
  bondfireId?: string // If responding to existing bondfire
  campId?: string
  tags?: string[]
  isResponse: boolean
  createMuxDirectUpload: (args: {
    filename: string
    contentType: string
    isResponse: boolean
    bondfireId?: string
    campId?: string
    tags?: string[]
    durationMs?: number
    width?: number
    height?: number
  }) => Promise<MuxDirectUpload>
  getMuxUploadStatus: (args: { uploadId: string }) => Promise<MuxUploadStatus>
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getExtensionFromUri(uri: string): string | null {
  const path = uri.split('?')[0]?.split('#')[0] ?? uri
  const lastSegment = path.split('/').pop() ?? ''
  const match = /\.([a-zA-Z0-9]+)$/.exec(lastSegment)
  return match?.[1]?.toLowerCase() ?? null
}

function getContentTypeForExtension(extension: string | null): string {
  switch (extension) {
    case 'mov':
      return 'video/quicktime'
    case 'm4v':
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case '3gp':
    case '3gpp':
      return 'video/3gpp'
    default:
      return 'video/mp4'
  }
}

function getUploadFileInfo(uri: string, fallbackTimestamp = Date.now()): UploadFileInfo {
  const extension = getExtensionFromUri(uri) ?? 'mp4'
  return {
    filename: `bondfire-${fallbackTimestamp}.${extension}`,
    contentType: getContentTypeForExtension(extension),
  }
}

async function uploadFileWithProgress(params: {
  uploadUrl: string
  fileUri: string
  contentType: string
  onProgress: (fractionComplete: number) => void
}): Promise<void> {
  const fileInfo = await getInfoAsync(params.fileUri)
  if (!fileInfo.exists) {
    throw new Error(`Video file not found: ${params.fileUri}`)
  }

  const uploadTask = createUploadTask(
    params.uploadUrl,
    params.fileUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': params.contentType,
      },
    },
    ({ totalBytesExpectedToSend, totalBytesSent }) => {
      const fraction =
        totalBytesExpectedToSend > 0
          ? totalBytesSent / totalBytesExpectedToSend
          : totalBytesSent > 0
            ? 1
            : 0
      params.onProgress(Math.max(0, Math.min(1, fraction)))
    },
  )

  const result = await uploadTask.uploadAsync()
  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error(`Mux upload failed with status ${result?.status ?? 'unknown'}`)
  }

  params.onProgress(1)
}

async function waitForMuxVideoReady(params: {
  upload: NonNullable<UploadTask['muxUpload']>
  options: BackgroundUploadOptions
  taskId: string
}): Promise<MuxUploadStatus> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < MUX_READY_TIMEOUT_MS) {
    const status = await params.options.getMuxUploadStatus({
      uploadId: params.upload.uploadId,
    })

    if (status.isFailed) {
      throw new Error('Mux failed to process the uploaded video')
    }

    if (status.isReady) {
      setTaskProgress(params.taskId, params.options, MUX_READY_PROGRESS, 'Video is ready')
      return status
    }

    const statusLabel = status.assetStatus ?? status.uploadStatus
    setTaskProgress(
      params.taskId,
      params.options,
      UPLOAD_END_PROGRESS,
      `Waiting for video processing (${statusLabel})...`,
    )
    await delay(MUX_READY_POLL_INTERVAL_MS)
  }

  throw new Error('Mux video is still processing. Upload will resume checking shortly.')
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
  const extension = getExtensionFromUri(uri) ?? 'mp4'
  const persistentPath = `${persistentDir}${Date.now()}-${Math.random().toString(36).substring(7)}.${extension}`

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
  const uploadFileInfo = getUploadFileInfo(persistentPath)

  // Create upload task
  const task: UploadTask = {
    id: taskId,
    videoFilePath: persistentPath,
    bondfireId: options.bondfireId,
    campId: options.campId,
    tags: options.tags,
    isResponse: options.isResponse,
    status: 'pending',
    progress: 0,
    stage: 'Queued',
    uploadFilename: uploadFileInfo.filename,
    uploadContentType: uploadFileInfo.contentType,
    attemptCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  uploadQueueActions.addTask(task)

  if (autoStart) {
    // Start processing (don't await - let it run in background)
    processUploadTask(taskId, options).catch((error) => {
      telemetry.error('upload:task', 'Background upload task failed', {
        taskId,
        error: String(error),
      })
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
    const uploadFileInfo: UploadFileInfo =
      task.uploadFilename && task.uploadContentType
        ? { filename: task.uploadFilename, contentType: task.uploadContentType }
        : getUploadFileInfo(task.videoFilePath)

    if (!task.uploadFilename || !task.uploadContentType) {
      uploadQueueActions.updateTask(taskId, {
        uploadFilename: uploadFileInfo.filename,
        uploadContentType: uploadFileInfo.contentType,
      })
    }

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

    // Step 2: Create Mux direct upload and pending Convex record if needed.
    let muxUpload = task.muxUpload
    if (!muxUpload) {
      setTaskProgress(taskId, options, PROCESSING_MAX_PROGRESS, 'Creating Mux upload...')
      muxUpload = await options.createMuxDirectUpload({
        filename: uploadFileInfo.filename,
        contentType: uploadFileInfo.contentType,
        isResponse: options.isResponse,
        bondfireId: options.bondfireId,
        campId: options.campId,
        tags: options.tags,
        durationMs: processed.metadata.durationMs,
        width: processed.metadata.width,
        height: processed.metadata.height,
      })

      uploadQueueActions.updateTask(taskId, {
        muxUpload,
      })
    }

    setTaskProgress(taskId, options, CREDENTIALS_READY_PROGRESS, 'Upload ready')

    // Step 3: Upload original video to Mux with progress.
    uploadQueueActions.updateTask(taskId, { status: 'uploading' })

    const uploadRange = UPLOAD_END_PROGRESS - CREDENTIALS_READY_PROGRESS
    if (task.muxUploadCompletedAt) {
      setTaskProgress(taskId, options, UPLOAD_END_PROGRESS, 'Upload complete')
    } else {
      await uploadFileWithProgress({
        uploadUrl: muxUpload.uploadUrl,
        fileUri: processed.uploadUri,
        contentType: uploadFileInfo.contentType,
        onProgress: (fraction) => {
          setTaskProgress(
            taskId,
            options,
            CREDENTIALS_READY_PROGRESS + uploadRange * fraction,
            'Uploading video...',
          )
        },
      })

      uploadQueueActions.updateTask(taskId, {
        muxUploadCompletedAt: Date.now(),
      })
    }

    // Step 4: Wait for Mux to make the playback ID available.
    await waitForMuxVideoReady({
      upload: muxUpload,
      options,
      taskId,
    })

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
    telemetry.error('upload:error', 'Upload error', {
      taskId,
      attempt: attemptCount,
      error: normalizedError.message,
    })
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
          telemetry.error('upload:retry', 'Retry failed', {
            taskId,
            attempt: attemptCount,
            error: String(err),
          })
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
      campId: task.campId,
      tags: task.tags,
      isResponse: task.isResponse,
    }

    // Resume processing
    processUploadTask(task.id, taskOptions).catch((error) => {
      telemetry.error('upload:resume', 'Failed to resume task', {
        taskId: task.id,
        error: String(error),
      })
    })
  }
}
