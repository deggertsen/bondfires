/**
 * Local backup recording policy (Phase 1 of docs/plans/local-backup-recording.md).
 *
 * While a live recording streams to Mux, the native publisher can also write a
 * local MP4 backup on-device. These pure functions decide whether a backup may
 * be armed for a session and when a leftover backup file has aged out. The
 * feature ships behind EXPO_PUBLIC_LOCAL_BACKUP_RECORDING (default OFF).
 */

/**
 * Minimum free disk space required before arming a backup. A typical
 * recording writes ~19 MB/min at 2.5 Mbps, so 500 MB leaves generous headroom
 * for the recording itself plus the rest of the OS.
 */
export const LOCAL_BACKUP_MIN_FREE_DISK_BYTES = 500 * 1024 * 1024

/**
 * How long an orphaned backup file may sit on disk before the launch sweep
 * deletes it. Matches the recovery window planned for Phase 2.
 */
export const LOCAL_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type LocalBackupSkipReason = 'flag_disabled' | 'low_disk' | 'disk_unknown'

export interface LocalBackupArmDecision {
  arm: boolean
  reason: LocalBackupSkipReason | null
}

/**
 * Whether a local backup should be armed for the upcoming recording.
 *
 * `freeDiskBytes` is `null` when the platform could not report free space —
 * treated as a skip (arming blind on a possibly-full disk risks breaking the
 * recording it exists to protect).
 */
export function shouldArmLocalBackup(args: {
  flagEnabled: boolean
  freeDiskBytes: number | null
}): LocalBackupArmDecision {
  if (!args.flagEnabled) {
    return { arm: false, reason: 'flag_disabled' }
  }
  if (args.freeDiskBytes === null || !Number.isFinite(args.freeDiskBytes)) {
    return { arm: false, reason: 'disk_unknown' }
  }
  if (args.freeDiskBytes < LOCAL_BACKUP_MIN_FREE_DISK_BYTES) {
    return { arm: false, reason: 'low_disk' }
  }
  return { arm: true, reason: null }
}

/** Whether an on-disk backup file has outlived the retention window. */
export function isBackupExpired(args: { modifiedAtMs: number; nowMs: number }): boolean {
  return args.nowMs - args.modifiedAtMs > LOCAL_BACKUP_RETENTION_MS
}
