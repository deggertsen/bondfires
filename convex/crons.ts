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

export default crons
