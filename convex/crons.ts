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

export default crons
