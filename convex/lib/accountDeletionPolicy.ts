export const ACCOUNT_DELETION_BATCH_SIZE = 25
export const ACCOUNT_DELETION_MEDIA_BATCH_SIZE = 8
export const ACCOUNT_DELETION_MAX_RETRY_DELAY_MS = 60 * 60 * 1000

export const ACCOUNT_DELETION_USER_STAGES = [
  'owned_camps',
  'camp_members',
  'invite_codes',
  'invite_claims_sender',
  'invite_claims_claimer',
  'notifications',
  'subscriptions',
  'slot_transactions',
  'consumable_purchases',
  'personal_participants',
  'personal_removed_by',
  'family_connections_first',
  'family_connections_second',
  'personal_camps',
  'reconciliation',
  'tier_target',
  'tier_admin',
  'admin_audit',
  'admin_audit_target',
  'admin_audit_subject',
  'moderated_bondfires',
  'moderated_responses',
  'reports_reviewer',
  'thread_reads',
  'pins_owned',
  'pins_incoming',
  'watch_events',
  'device_tokens',
  'notification_deliveries',
  'reports_reporter',
  'reports_owner',
  'client_logs',
  'client_log_rate_limit',
  'invites_sender',
  'invites_recipient',
  'blocks_outgoing',
  'blocks_incoming',
  'reactions',
  'presence',
  'auth_accounts',
  'auth_rate_limit',
  'queue_content',
  'queue_media',
  'finalize',
] as const

export type AccountDeletionUserStage = (typeof ACCOUNT_DELETION_USER_STAGES)[number]

export function nextAccountDeletionStage(stage: string | undefined): AccountDeletionUserStage {
  if (!stage) return ACCOUNT_DELETION_USER_STAGES[0]
  const index = ACCOUNT_DELETION_USER_STAGES.indexOf(stage as AccountDeletionUserStage)
  return ACCOUNT_DELETION_USER_STAGES[Math.min(index + 1, ACCOUNT_DELETION_USER_STAGES.length - 1)]
}

export function accountDeletionRetryDelay(attempts: number) {
  return Math.min(
    2 ** Math.min(Math.max(0, attempts), 20) * 1_000,
    ACCOUNT_DELETION_MAX_RETRY_DELAY_MS,
  )
}

export interface DeletableMuxVideo {
  muxUploadId?: string
  muxAssetId?: string
  muxLiveStreamId?: string
}

export interface DeletableMuxSession {
  muxLiveStreamId?: string
  muxActiveAssetId?: string
  muxRecentAssetId?: string
  muxRecordedAssetId?: string
}

export function collectMuxDeletionTargets(
  video: DeletableMuxVideo | null,
  session: DeletableMuxSession | null,
) {
  const assets = new Set<string>()
  const liveStreams = new Set<string>()
  const directUploads = new Set<string>()
  if (video?.muxUploadId) directUploads.add(video.muxUploadId)
  if (video?.muxAssetId) assets.add(video.muxAssetId)
  if (video?.muxLiveStreamId) liveStreams.add(video.muxLiveStreamId)
  if (session?.muxLiveStreamId) liveStreams.add(session.muxLiveStreamId)
  for (const assetId of [
    session?.muxActiveAssetId,
    session?.muxRecentAssetId,
    session?.muxRecordedAssetId,
  ]) {
    if (assetId) assets.add(assetId)
  }
  return {
    directUploads: [...directUploads],
    assets: [...assets],
    liveStreams: [...liveStreams],
  }
}
