import {
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy'
import { isBackupExpired } from '../utils/localBackupPolicy'
import { telemetry } from './telemetry'

/**
 * Launch sweep for local backup recordings (Phase 1 of
 * docs/plans/local-backup-recording.md).
 *
 * The native publisher writes a parallel MP4 backup of each live recording to
 * <documents>/recordings/<liveSessionId>.mp4. The happy path deletes it at
 * stop/cancel time; this sweep is the backstop for everything else (crashes,
 * kills, failed deletes): expired files are removed, files whose live asset
 * resolved to 'ready' are removed, and everything else is kept for Phase 2's
 * recovery upload.
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

export interface LocalBackupSweepOptions {
  /** Auth-gated status lookup (convex videos.getLiveSessionRecordStatus). */
  getLiveSessionRecordStatus: (args: {
    liveSessionId: string
  }) => Promise<{ videoStatus: string | null }>
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

  for (const fileName of fileNames) {
    try {
      if (!fileName.endsWith('.mp4')) {
        continue
      }
      const fileUri = `${directoryUri}${fileName}`
      const info = await getInfoAsync(fileUri)
      if (!info.exists || info.isDirectory) {
        continue
      }
      // Android rolls a reconnect's pre-drop leg to <sessionId>.partN.mp4;
      // strip the suffix so parts share their session's retention/ready fate.
      const liveSessionId = fileName.slice(0, -'.mp4'.length).replace(/\.part\d+$/, '')
      // expo-file-system reports modificationTime in seconds. A missing
      // timestamp must mean "keep" (treat as new), never "expired" — a 0
      // fallback would delete a file we merely failed to stat.
      const modifiedAtMs = info.modificationTime != null ? info.modificationTime * 1000 : Date.now()
      const sizeBytes = info.size

      if (isBackupExpired({ modifiedAtMs, nowMs: Date.now() })) {
        await deleteAsync(fileUri, { idempotent: true })
        telemetry.info('backup:discarded', 'Expired local backup deleted', {
          liveSessionId,
          reason: 'retention',
          sizeBytes,
        })
        continue
      }

      const { videoStatus } = await options.getLiveSessionRecordStatus({ liveSessionId })
      if (videoStatus === 'ready') {
        await deleteAsync(fileUri, { idempotent: true })
        telemetry.info('backup:discarded', 'Local backup deleted — live asset is ready', {
          liveSessionId,
          reason: 'asset_ready',
          sizeBytes,
        })
        continue
      }

      telemetry.breadcrumb('backup:kept', {
        liveSessionId,
        videoStatus,
        sizeBytes,
        modifiedAtMs,
      })
    } catch (error) {
      // A bad file or failed status query must never stop the sweep — keep
      // the file (footage is only deleted on positive evidence) and move on.
      telemetry.warn('backup:sweep_file_failed', 'Failed to sweep local backup file', {
        fileName,
        error: String(error),
      })
    }
  }
}
