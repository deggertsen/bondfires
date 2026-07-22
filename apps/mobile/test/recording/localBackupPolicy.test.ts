import { describe, expect, it } from 'vitest'
import {
  isBackupExpired,
  LOCAL_BACKUP_MIN_FREE_DISK_BYTES,
  LOCAL_BACKUP_RETENTION_MS,
  shouldArmLocalBackup,
} from '../../../../packages/app/src/utils/localBackupPolicy'

describe('shouldArmLocalBackup', () => {
  it('arms when the flag is on and disk headroom is sufficient', () => {
    expect(
      shouldArmLocalBackup({
        flagEnabled: true,
        freeDiskBytes: LOCAL_BACKUP_MIN_FREE_DISK_BYTES,
      }),
    ).toEqual({ arm: true, reason: null })
  })

  it('skips when the feature flag is off, regardless of disk space', () => {
    expect(
      shouldArmLocalBackup({
        flagEnabled: false,
        freeDiskBytes: LOCAL_BACKUP_MIN_FREE_DISK_BYTES * 10,
      }),
    ).toEqual({ arm: false, reason: 'flag_disabled' })
  })

  it('skips under the free-disk floor', () => {
    expect(
      shouldArmLocalBackup({
        flagEnabled: true,
        freeDiskBytes: LOCAL_BACKUP_MIN_FREE_DISK_BYTES - 1,
      }),
    ).toEqual({ arm: false, reason: 'low_disk' })
  })

  it('skips when free disk space could not be measured', () => {
    expect(shouldArmLocalBackup({ flagEnabled: true, freeDiskBytes: null })).toEqual({
      arm: false,
      reason: 'disk_unknown',
    })
    expect(shouldArmLocalBackup({ flagEnabled: true, freeDiskBytes: Number.NaN })).toEqual({
      arm: false,
      reason: 'disk_unknown',
    })
  })
})

describe('isBackupExpired', () => {
  const modifiedAtMs = 1_700_000_000_000

  it('keeps files within the retention window', () => {
    expect(isBackupExpired({ modifiedAtMs, nowMs: modifiedAtMs })).toBe(false)
    expect(isBackupExpired({ modifiedAtMs, nowMs: modifiedAtMs + LOCAL_BACKUP_RETENTION_MS })).toBe(
      false,
    )
  })

  it('expires files older than the retention window', () => {
    expect(
      isBackupExpired({ modifiedAtMs, nowMs: modifiedAtMs + LOCAL_BACKUP_RETENTION_MS + 1 }),
    ).toBe(true)
  })
})
