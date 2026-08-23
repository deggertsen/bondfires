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

/**
 * Should reaching 'ready' announce this record to its camp or thread?
 *
 * Live rows are announced when Mux reports the stream watchable, which is also
 * where `liveSessions.startedAt` is stamped — so an unset `startedAt` means
 * nobody was ever told. That is the normal state for a backup recovery: the
 * stream dropped early or never pushed a frame, making 'ready' the first moment
 * its audience can hear about it. Notification delivery dedupes per recipient
 * on a stable video key, so announcing a session that did go live can't produce
 * a second push.
 */
export function shouldAnnounceRecordOnReady(args: {
  liveSessionId?: string
  liveSessionStartedAt?: number
}): boolean {
  if (!args.liveSessionId) {
    return true
  }
  return args.liveSessionStartedAt === undefined
}

/** Only sessions that positively confirmed an on-device file get deferred. */
export function shouldDeferLiveFailureForBackup(args: {
  localBackupAvailable: boolean
  assetStatus?: string
  durationLimitExceededStatus: string
}): boolean {
  return args.localBackupAvailable && args.assetStatus !== args.durationLimitExceededStatus
}

/**
 * Stop carries final on-device file evidence in the same authenticated action
 * that evaluates Mux ingest. Persisted arm evidence remains a fallback for
 * system/crash paths that cannot report the final file stat directly.
 */
export function hasLocalBackupEvidence(args: {
  reportedAtStop?: boolean
  persistedAtArm?: boolean
}): boolean {
  return args.reportedAtStop === true || args.persistedAtArm === true
}
