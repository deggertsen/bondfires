import { describe, expect, it } from 'vitest'
import {
  decideReadyAssetConflict,
  hasLocalBackupEvidence,
  shouldAnnounceRecordOnReady,
  shouldDeferLiveFailureForBackup,
  shouldIgnoreErroredLiveAsset,
} from './liveBackupRecovery'

describe('decideReadyAssetConflict', () => {
  it('accepts the first playable asset and idempotent repeats', () => {
    expect(
      decideReadyAssetConflict({
        incomingAssetId: 'asset-live',
        incomingSource: 'live',
      }),
    ).toBe('accept')
    expect(
      decideReadyAssetConflict({
        existingAssetId: 'asset-live',
        existingPlaybackId: 'playback-live',
        incomingAssetId: 'asset-live',
        incomingSource: 'live',
      }),
    ).toBe('accept')
  })

  it('keeps a ready live asset when a backup finishes later', () => {
    expect(
      decideReadyAssetConflict({
        existingAssetId: 'asset-live',
        existingPlaybackId: 'playback-live',
        incomingAssetId: 'asset-backup',
        incomingSource: 'backup',
      }),
    ).toBe('keep_existing')
  })

  it('replaces a ready backup when the live VOD finishes later', () => {
    expect(
      decideReadyAssetConflict({
        existingAssetId: 'asset-backup',
        existingPlaybackId: 'playback-backup',
        incomingAssetId: 'asset-live',
        incomingSource: 'live',
      }),
    ).toBe('replace_existing')
  })

  it('does not let an unknown duplicate source displace playable video', () => {
    expect(
      decideReadyAssetConflict({
        existingAssetId: 'asset-existing',
        existingPlaybackId: 'playback-existing',
        incomingAssetId: 'asset-unknown',
        incomingSource: 'unknown',
      }),
    ).toBe('keep_existing')
  })
})

describe('hasLocalBackupEvidence', () => {
  it('preserves a never-active recording from either final or persisted evidence', () => {
    expect(hasLocalBackupEvidence({ reportedAtStop: true })).toBe(true)
    expect(hasLocalBackupEvidence({ persistedAtArm: true })).toBe(true)
    expect(hasLocalBackupEvidence({})).toBe(false)
  })
})

describe('shouldAnnounceRecordOnReady', () => {
  it('announces direct uploads, which have no live session to announce them', () => {
    expect(shouldAnnounceRecordOnReady({})).toBe(true)
  })

  it('announces a recovery for a stream that never became watchable', () => {
    expect(shouldAnnounceRecordOnReady({ liveSessionId: 'session-1' })).toBe(true)
  })

  it('stays silent when the stream already announced itself at go-live', () => {
    expect(
      shouldAnnounceRecordOnReady({ liveSessionId: 'session-1', liveSessionStartedAt: 1 }),
    ).toBe(false)
  })
})

describe('shouldDeferLiveFailureForBackup', () => {
  it('defers only when the device positively confirmed a backup', () => {
    expect(
      shouldDeferLiveFailureForBackup({
        localBackupAvailable: true,
        assetStatus: 'errored',
        durationLimitExceededStatus: 'duration_limit_exceeded',
      }),
    ).toBe(true)
    expect(
      shouldDeferLiveFailureForBackup({
        localBackupAvailable: false,
        assetStatus: 'errored',
        durationLimitExceededStatus: 'duration_limit_exceeded',
      }),
    ).toBe(false)
  })

  it('never defers a duration violation that the backup cannot repair', () => {
    expect(
      shouldDeferLiveFailureForBackup({
        localBackupAvailable: true,
        assetStatus: 'duration_limit_exceeded',
        durationLimitExceededStatus: 'duration_limit_exceeded',
      }),
    ).toBe(false)
  })
})

describe('shouldIgnoreErroredLiveAsset', () => {
  it('ignores failed RTMP legs while the parent live stream can reconnect', () => {
    for (const liveSessionStatus of ['starting', 'live', 'ending']) {
      expect(
        shouldIgnoreErroredLiveAsset({
          liveStreamId: 'live-1',
          liveSessionStatus,
          assetId: 'failed-leg',
        }),
      ).toBe(true)
    }
  })

  it('ignores a losing leg after the final asset is known', () => {
    expect(
      shouldIgnoreErroredLiveAsset({
        liveStreamId: 'live-1',
        liveSessionStatus: 'ended',
        assetId: 'failed-leg',
        recentAssetId: 'final-leg',
      }),
    ).toBe(true)
  })

  it('keeps direct uploads and the ended stream final asset terminal', () => {
    expect(
      shouldIgnoreErroredLiveAsset({
        liveSessionStatus: 'live',
        assetId: 'asset-1',
      }),
    ).toBe(false)
    expect(
      shouldIgnoreErroredLiveAsset({
        liveStreamId: 'live-1',
        liveSessionStatus: 'ended',
        assetId: 'final-leg',
        recentAssetId: 'final-leg',
      }),
    ).toBe(false)
  })
})
