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

// Burn 1 slot per active public camp on its monthly consumption anniversary.
// Idempotent: uses period-bounded checks so it's safe to run multiple times.
// Runs daily at 10:00 UTC.
crons.daily(
  'burn daily camp slots',
  { hourUTC: 10, minuteUTC: 0 },
  internal.campSlots.burnDailyCampSlots,
)

// Grant 3 free monthly slots to Pro subscribers.
// Idempotent: uses period-bounded checks so it's safe to run multiple times.
// Runs daily at 10:30 UTC (offset from consumption burn to ensure grants
// land before consumption checks on the same day).
crons.daily(
  'grant daily pro slots',
  { hourUTC: 10, minuteUTC: 30 },
  internal.campSlots.grantDailyProSlots,
)

export default crons
