export type RecordedAssetSource = 'live' | 'backup' | 'direct' | 'unknown'

export type ReadyAssetConflictDecision = 'accept' | 'keep_existing' | 'replace_existing'

/**
 * Resolve a race between an already-playable asset and a different asset that
 * just became ready. A recorded live VOD always replaces a recovery upload;
 * uploads and unknown sources never displace an already-playable recording.
 */
export function decideReadyAssetConflict(args: {
  existingAssetId?: string
  existingPlaybackId?: string
  incomingAssetId: string
  incomingSource: RecordedAssetSource
}): ReadyAssetConflictDecision {
  if (
    !args.existingAssetId ||
    !args.existingPlaybackId ||
    args.existingAssetId === args.incomingAssetId
  ) {
    return 'accept'
  }

  return args.incomingSource === 'live' ? 'replace_existing' : 'keep_existing'
}

/** Only sessions that positively confirmed an on-device file get deferred. */
export function shouldDeferLiveFailureForBackup(args: {
  localBackupAvailable: boolean
  assetStatus?: string
  durationLimitExceededStatus: string
}): boolean {
  return args.localBackupAvailable && args.assetStatus !== args.durationLimitExceededStatus
}
