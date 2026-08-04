import {
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy'
import {
  isBackupExpired,
  parseLocalBackupFileName,
  shouldEnqueueLiveBackupRecovery,
} from '../utils/localBackupPolicy'
import { telemetry } from './telemetry'

/**
 * Launch sweep for local backup recordings (Phase 1+2 of
 * docs/plans/local-backup-recording.md).
 *
 * The native publisher writes a parallel MP4 backup of each live recording to
 * <documents>/recordings/<liveSessionId>.mp4. User cancellation deletes it
 * immediately; successful recordings stay until this sweep confirms that the
 * live asset is ready. Phase 2: recovery-eligible leftovers are enqueued into
 * the upload queue as `live_backup` tasks.
 */

/**
 * Directory (under the app documents dir) where the native publisher writes
 * local backup MP4s. Must stay in sync with:
 * - iOS: backupRecordingsDirectory() in BondfireLivePublisherModule.swift
 *   (<Documents>/recordings/)
 * - Android: the recordings dir in BondfireLivePublisherModule.kt
 *   (<filesDir>/recordings/)
 * expo-file-system's `documentDirectory` maps to <Documents>/ on iOS and to
 * context.filesDir on Android, so one JS path covers both.
 */
export const LOCAL_BACKUP_DIRECTORY_NAME = 'recordings'

/** file:// URI of the backup directory, or null where unavailable (web). */
export function getLocalBackupDirectoryUri(): string | null {
  if (!documentDirectory) {
    return null
  }
  return `${documentDirectory}${LOCAL_BACKUP_DIRECTORY_NAME}/`
}

/** file:// URI for one backup file, or null where unavailable (web). */
export function getLocalBackupFileUri(fileName: string): string | null {
  const directoryUri = getLocalBackupDirectoryUri()
  return directoryUri ? `${directoryUri}${fileName}` : null
}

async function getLocalBackupFileNamesForSession(liveSessionId: string): Promise<string[]> {
  const directoryUri = getLocalBackupDirectoryUri()
  if (!directoryUri) {
    return []
  }
  const directoryInfo = await getInfoAsync(directoryUri)
  if (!directoryInfo.exists || !directoryInfo.isDirectory) {
    return []
  }
  const fileNames = await readDirectoryAsync(directoryUri)
  return fileNames.filter(
    (fileName) => parseLocalBackupFileName(fileName)?.liveSessionId === liveSessionId,
  )
}

export interface LocalBackupSessionStats {
  exists: boolean
  fileCount: number
  sizeBytes: number
  /** Largest file URI for the session (primary or Android .partN). */
  bestFileUri: string | null
  bestFileName: string | null
}

/** Aggregate the primary backup and every Android reconnect segment. */
export async function getLocalBackupSessionStats(
  liveSessionId: string,
): Promise<LocalBackupSessionStats> {
  const directoryUri = getLocalBackupDirectoryUri()
  if (!directoryUri) {
    return {
      exists: false,
      fileCount: 0,
      sizeBytes: 0,
      bestFileUri: null,
      bestFileName: null,
    }
  }
  const fileNames = await getLocalBackupFileNamesForSession(liveSessionId)
  let fileCount = 0
  let sizeBytes = 0
  let bestFileUri: string | null = null
  let bestFileName: string | null = null
  let bestSize = -1
  for (const fileName of fileNames) {
    const info = await getInfoAsync(`${directoryUri}${fileName}`)
    if (info.exists && !info.isDirectory) {
      fileCount += 1
      const fileSize = info.size ?? 0
      sizeBytes += fileSize
      if (fileSize > bestSize) {
        bestSize = fileSize
        bestFileUri = `${directoryUri}${fileName}`
        bestFileName = fileName
      }
    }
  }
  return { exists: fileCount > 0, fileCount, sizeBytes, bestFileUri, bestFileName }
}

/** Delete the primary backup and every Android reconnect segment. */
export async function deleteLocalBackupsForSession(liveSessionId: string): Promise<number> {
  const directoryUri = getLocalBackupDirectoryUri()
  if (!directoryUri) {
    return 0
  }
  const fileNames = await getLocalBackupFileNamesForSession(liveSessionId)
  let deletedCount = 0
  let firstError: unknown
  for (const fileName of fileNames) {
    try {
      await deleteAsync(`${directoryUri}${fileName}`, { idempotent: true })
      deletedCount += 1
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) {
    throw firstError
  }
  return deletedCount
}

export interface LiveSessionRecordStatus {
  videoStatus: string | null
  recordId?: string | null
  recordType?: 'bondfire' | 'response' | null
  recoveryEligible?: boolean
}

export interface LocalBackupSweepOptions {
  /** Auth-gated status lookup (convex videos.getLiveSessionRecordStatus). */
  getLiveSessionRecordStatus: (args: { liveSessionId: string }) => Promise<LiveSessionRecordStatus>
  /** Optional Phase 2 recovery enqueue. When omitted, eligible files are kept. */
  enqueueLiveBackupRecovery?: (args: {
    liveSessionId: string
    fileUri: string
    recordId?: string | null
    recordType?: 'bondfire' | 'response' | null
  }) => Promise<void>
}

/**
 * Sweep the backup directory once. Fully fire-and-forget and crash-safe:
 * every file is handled inside its own try/catch and nothing propagates to
 * the caller. Errs on the side of keeping files — only a confirmed 'ready'
 * asset or the retention window may delete footage.
 */
export async function sweepLocalBackups(options: LocalBackupSweepOptions): Promise<void> {
  const directoryUri = getLocalBackupDirectoryUri()
  if (!directoryUri) {
    return
  }

  let fileNames: string[]
  try {
    const directoryInfo = await getInfoAsync(directoryUri)
    if (!directoryInfo.exists) {
      return
    }
    fileNames = await readDirectoryAsync(directoryUri)
  } catch (error) {
    telemetry.warn('backup:sweep_failed', 'Failed to enumerate local backup directory', {
      error: String(error),
    })
    return
  }

  // Group by liveSessionId so Android .partN segments enqueue once.
  const filesBySession = new Map<string, string[]>()
  for (const fileName of fileNames) {
    const identity = parseLocalBackupFileName(fileName)
    if (!identity) {
      continue
    }
    const existing = filesBySession.get(identity.liveSessionId) ?? []
    existing.push(fileName)
    filesBySession.set(identity.liveSessionId, existing)
  }

  for (const [liveSessionId, sessionFileNames] of filesBySession) {
    try {
      let oldestModifiedAtMs = Date.now()
      let totalSizeBytes = 0
      let bestFileUri: string | null = null
      let bestSize = -1
      let anyExists = false

      for (const fileName of sessionFileNames) {
        const fileUri = `${directoryUri}${fileName}`
        const info = await getInfoAsync(fileUri)
        if (!info.exists || info.isDirectory) {
          continue
        }
        anyExists = true
        const fileSize = info.size ?? 0
        totalSizeBytes += fileSize
        if (fileSize > bestSize) {
          bestSize = fileSize
          bestFileUri = fileUri
        }
        // expo-file-system reports modificationTime in seconds. A missing
        // timestamp must mean "keep" (treat as new), never "expired".
        const modifiedAtMs =
          info.modificationTime != null ? info.modificationTime * 1000 : Date.now()
        if (modifiedAtMs < oldestModifiedAtMs) {
          oldestModifiedAtMs = modifiedAtMs
        }
      }

      if (!anyExists || !bestFileUri) {
        continue
      }

      if (isBackupExpired({ modifiedAtMs: oldestModifiedAtMs, nowMs: Date.now() })) {
        await deleteLocalBackupsForSession(liveSessionId)
        telemetry.info('backup:discarded', 'Expired local backup deleted', {
          liveSessionId,
          reason: 'retention',
          sizeBytes: totalSizeBytes,
        })
        continue
      }

      const status = await options.getLiveSessionRecordStatus({ liveSessionId })
      const decision = shouldEnqueueLiveBackupRecovery({
        videoStatus: status.videoStatus,
        recoveryEligible: status.recoveryEligible,
      })

      if (decision === 'delete_ready') {
        await deleteLocalBackupsForSession(liveSessionId)
        telemetry.info('backup:discarded', 'Local backup deleted — live asset is ready', {
          liveSessionId,
          reason: 'asset_ready',
          sizeBytes: totalSizeBytes,
        })
        continue
      }

      if (decision === 'enqueue' && options.enqueueLiveBackupRecovery) {
        await options.enqueueLiveBackupRecovery({
          liveSessionId,
          fileUri: bestFileUri,
          recordId: status.recordId,
          recordType: status.recordType,
        })
        telemetry.info('backup:recovery_sweep', 'Sweep enqueued local backup recovery', {
          liveSessionId,
          videoStatus: status.videoStatus,
          sizeBytes: totalSizeBytes,
        })
        continue
      }

      telemetry.breadcrumb('backup:kept', {
        liveSessionId,
        videoStatus: status.videoStatus,
        sizeBytes: totalSizeBytes,
        modifiedAtMs: oldestModifiedAtMs,
      })
    } catch (error) {
      // A bad file or failed status query must never stop the sweep — keep
      // the file (footage is only deleted on positive evidence) and move on.
      telemetry.warn('backup:sweep_file_failed', 'Failed to sweep local backup session', {
        liveSessionId,
        error: String(error),
      })
    }
  }
}
