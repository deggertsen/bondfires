import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef } from 'react'
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

  // Subscribe to the viewer list only when videoId is defined.
  const rawViewers = useQuery(
    api.presence.listViewers,
    videoId ? { videoType, videoId } : 'skip',
  )

  // Refs for cleanup
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const videoTypeRef = useRef(videoType)
  const videoIdRef = useRef(videoId)

  videoTypeRef.current = videoType
  videoIdRef.current = videoId

  // Clear interval helper
  const clearHeartbeatInterval = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  // Main lifecycle effect: start/stop heartbeats based on conditions
  useEffect(() => {
    const shouldBeat = isActive && isScreenFocused && isAppActive && !!videoId

    if (shouldBeat) {
      // Fire immediately — don't wait 30s for the first beat
      heartbeat({ videoType, videoId: videoId! }).catch(() => {
        // Silent: network errors will retry on next interval
      })

      intervalRef.current = setInterval(() => {
        heartbeat({ videoType: videoTypeRef.current, videoId: videoIdRef.current! }).catch(() => {
          // Silent: network errors will retry on next interval
        })
      }, HEARTBEAT_INTERVAL_MS)
    } else {
      clearHeartbeatInterval()
    }

    return () => {
      clearHeartbeatInterval()
    }
  }, [isActive, isScreenFocused, isAppActive, videoId, videoType, heartbeat])

  // Leave viewing when conditions become false (but component still mounted)
  useEffect(() => {
    const wasActive = useRef(false)

    const shouldBeActive = isActive && isScreenFocused && isAppActive && !!videoId

    if (wasActive.current && !shouldBeActive && videoIdRef.current) {
      leaveViewing({ videoType: videoTypeRef.current, videoId: videoIdRef.current }).catch(() => {
        // Silent: best-effort cleanup
      })
    }

    wasActive.current = shouldBeActive
  }, [isActive, isScreenFocused, isAppActive, videoId, leaveViewing])

  // On unmount: call leaveViewing
  useEffect(() => {
    return () => {
      if (videoIdRef.current) {
        leaveViewing({ videoType: videoTypeRef.current, videoId: videoIdRef.current }).catch(() => {
          // Silent: best-effort cleanup
        })
      }
    }
  }, [leaveViewing])

  // Filter out the current user from the viewer list
  const viewers: Viewer[] = (rawViewers ?? []).filter(
    (v: Viewer) => v.userId !== currentUserId,
  )

  return { viewers }
}