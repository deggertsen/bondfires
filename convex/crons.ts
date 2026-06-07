import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'disable stale Mux live streams',
  { minutes: 5 },
  internal.videos.disableStaleLiveStreams,
)

crons.daily(
  'cleanup expired private camp videos',
  { hourUTC: 8, minuteUTC: 0 },
  internal.videos.cleanupExpiredPrivateCampVideos,
  { limit: 100 },
)

// Process frozen camps whose 30-day reclaim window has expired.
// Runs daily at 9:00 UTC to catch expired reclaim deadlines.
crons.daily(
  'process expired camp reclaims',
  { hourUTC: 9, minuteUTC: 0 },
  internal.subscriptions.processExpiredReclaims,
)

// Grant 3 free monthly slots to Pro subscribers.
// Idempotent: uses billing-period checks so it's safe to run multiple times.
// Runs daily at 10:00 UTC, before camp slot consumption.
crons.daily(
  'grant daily pro slots',
  { hourUTC: 10, minuteUTC: 0 },
  internal.campSlots.grantDailyProSlots,
)

// Burn 1 slot per active public camp on its monthly consumption anniversary.
// Idempotent: uses camp-period checks so it's safe to run multiple times.
// Runs daily at 10:30 UTC after monthly grants have landed.
crons.daily(
  'burn daily camp slots',
  { hourUTC: 10, minuteUTC: 30 },
  internal.campSlots.burnDailyCampSlots,
)

// Move expired grace-period public camps to inactive.
// Runs daily at 11:00 UTC after monthly camp slot consumption.
crons.daily(
  'expire grace period camps',
  { hourUTC: 11, minuteUTC: 0 },
  internal.campSlots.expireGracePeriodCamps,
)

// Purge client telemetry logs older than 30 days.
// Runs daily at 12:00 UTC.
crons.daily('purge old client logs', { hourUTC: 12, minuteUTC: 0 }, internal.clientLogs.purgeOld)

// Cleanup archived camps past the 30-day retention window.
// Runs daily at 13:00 UTC — deletes Mux assets then camp data.
crons.daily(
  'cleanup archived camps',
  { hourUTC: 13, minuteUTC: 0 },
  internal.cleanup.dailyCleanupArchivedCamps,
)

// Run daily camp slot reconciliation at 14:00 UTC.
// Compares ledger against verified store purchases and logs discrepancies.
crons.daily(
  'daily slot reconciliation',
  { hourUTC: 14, minuteUTC: 0 },
  internal.reconciliation.dailyReconciliation,
)

// Enforce hearth video retention: Plus = 30-day rolling deletion.
// Premium and Pro owners have unlimited retention and are skipped.
// Only deletes videos (and their Mux assets) — bondfire shells and
// participant data are preserved.
// Runs daily at 15:00 UTC, after all other daily cleanup jobs.
crons.daily(
  'enforce hearth video retention',
  { hourUTC: 15, minuteUTC: 0 },
  internal.personalCampRetention.enforcePersonalCampRetention,
)

export default crons
