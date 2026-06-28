import { useMutation, useQuery } from 'convex/react'
import { useEffect, useMemo } from 'react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

export interface Viewer {
  _id: Id<'presence'>
  userId: Id<'users'>
  userName: string
  userPhotoUrl?: string
  lastHeartbeatAt: number
}

export interface UsePresenceOptions {
  videoType: 'bondfire' | 'response'
  videoId: string | undefined
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  currentUserId: Id<'users'> | string | undefined
}

export interface UsePresenceResult {
  viewers: Viewer[]
}

const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Manages presence heartbeats and viewer list subscriptions for a video.
 *
 * - When all conditions are met (active, focused, app foreground, videoId defined),
 *   fires a heartbeat immediately and then every 30 seconds.
 * - When any condition becomes false, clears the interval and calls leaveViewing.
 * - Subscribes to the viewer list via useQuery, filtering out the current user.
 * - On unmount, calls leaveViewing.
 */
export function usePresence({
  videoType,
  videoId,
  isActive,
  isScreenFocused,
  isAppActive,
  currentUserId,
}: UsePresenceOptions): UsePresenceResult {
  const heartbeat = useMutation(api.presence.heartbeat)
  const leaveViewing = useMutation(api.presence.leaveViewing)
  const shouldTrackPresence = isActive && isScreenFocused && isAppActive

  const rawViewers = useQuery(
    api.presence.listViewers,
    shouldTrackPresence && videoId ? { videoType, videoId } : 'skip',
  )

  useEffect(() => {
    if (!shouldTrackPresence || !videoId) {
      return
    }

    const session = { videoType, videoId }
    const beat = () => {
      heartbeat(session).catch(() => {
        // Best effort: transient failures retry on the next heartbeat.
      })
    }

    beat()
    const intervalId = setInterval(beat, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
      leaveViewing(session).catch(() => {
        // Best effort: stale rows are also removed by the server cleanup cron.
      })
    }
  }, [heartbeat, leaveViewing, shouldTrackPresence, videoId, videoType])

  const viewers = useMemo(
    () => (rawViewers ?? []).filter((viewer) => viewer.userId !== currentUserId),
    [currentUserId, rawViewers],
  )

  return { viewers }
}
