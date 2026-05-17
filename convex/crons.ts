import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'disable stale Mux live streams',
  { minutes: 5 },
  internal.videos.disableStaleLiveStreams,
)

export default crons
