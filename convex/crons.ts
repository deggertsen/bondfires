import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'disable stale Mux live streams',
  { minutes: 5 },
  internal.videos.disableStaleLiveStreams,
)

// Recover videos stuck in 'processing' / 'waiting_for_upload' when a Mux
// webhook was missed or unmatched. Queries Mux directly as the source of
// truth and promotes records to 'ready' or marks them 'errored'.
crons.interval(
  'reconcile stuck Mux videos',
  { minutes: 15 },
  internal.videos.reconcileStuckMuxVideos,
  {},
)

// Process frozen camps whose 30-day reclaim window has expired.
// Runs daily at 9:00 UTC to catch expired reclaim deadlines.
crons.daily(
  'process expired camp reclaims',
  { hourUTC: 9, minuteUTC: 0 },
  internal.subscriptions.processExpiredReclaims,
)

// Grant 3 free monthly kindling to Pro subscribers.
// Idempotent: uses billing-period checks so it's safe to run multiple times.
// Runs daily at 10:00 UTC, before camp kindling consumption.
crons.daily(
  'grant daily pro kindling',
  { hourUTC: 10, minuteUTC: 0 },
  internal.campKindling.grantDailyProKindling,
)

// Burn 1 kindling per active public camp on its monthly consumption anniversary.
// Idempotent: uses camp-period checks so it's safe to run multiple times.
// Runs daily at 10:30 UTC after monthly grants have landed.
crons.daily(
  'burn daily camp kindling',
  { hourUTC: 10, minuteUTC: 30 },
  internal.campKindling.burnDailyCampKindling,
)

// Move expired grace-period public camps to inactive.
// Runs daily at 11:00 UTC after monthly camp kindling consumption.
crons.daily(
  'expire grace period camps',
  { hourUTC: 11, minuteUTC: 0 },
  internal.campKindling.expireGracePeriodCamps,
)

// Purge client telemetry logs older than 30 days.
// Runs daily at 12:00 UTC.
crons.daily('purge old client logs', { hourUTC: 12, minuteUTC: 0 }, internal.clientLogs.purgeOld)

// Cleanup expired invite codes.
// Runs daily at 12:30 UTC, after log purge.
crons.daily(
  'cleanup expired invite codes',
  { hourUTC: 12, minuteUTC: 30 },
  internal.inviteCodes.cleanupExpiredInviteCodes,
)

// Cleanup archived camps past the 30-day retention window.
// Runs daily at 13:00 UTC — deletes Mux assets then camp data.
crons.daily(
  'cleanup archived camps',
  { hourUTC: 13, minuteUTC: 0 },
  internal.cleanup.dailyCleanupArchivedCamps,
)

// Repair bondfire.videoCount drift and backfill countedAt markers.
// Self-paginates; logs video:count_drift for any disagreement it heals.
// Runs daily at 13:30 UTC, between archived-camp cleanup and reconciliation.
crons.daily(
  'repair bondfire video counts',
  { hourUTC: 13, minuteUTC: 30 },
  internal.videoCountRepair.repairVideoCounts,
  {},
)

// Run daily camp kindling reconciliation at 14:00 UTC.
// Compares ledger against verified store purchases and logs discrepancies.
crons.daily(
  'daily kindling reconciliation',
  { hourUTC: 14, minuteUTC: 0 },
  internal.reconciliation.dailyReconciliation,
)

// Enforce bondfire-level video retention: Plus/Free = 30-day expiry from
// newest activity in the bondfire thread. An entire bondfire (spark + all
// responses) is deleted when no video in the thread is newer than 30 days.
// Premium and Pro owners have unlimited retention and are always skipped.
// Runs daily at 15:00 UTC, after all other daily cleanup jobs.
//
// TODO: Increase frequency as traffic grows (every 6h → every 1h) to avoid
// large batch backlogs.
crons.daily(
  'enforce bondfire video retention',
  { hourUTC: 15, minuteUTC: 0 },
  internal.bondfireRetention.enforceBondfireRetention,
)

// Send daily unwatched-activity digests (and 72h nudges) to users whose
// local digest window (~5pm) just opened. Runs hourly so every timezone
// gets local-evening delivery; idempotent via notificationDeliveries.
crons.hourly('send digest reminders', { minuteUTC: 10 }, internal.digest.runHourlySweep)

// Final push + email warning to owners of frozen/inactive camps whose
// reclaim deadline is within 3 days. Idempotent via notificationDeliveries.
crons.daily(
  'send camp reclaim warnings',
  { hourUTC: 16, minuteUTC: 0 },
  internal.sendNotification.sendReclaimWarnings,
)

export default crons
