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

export default crons
