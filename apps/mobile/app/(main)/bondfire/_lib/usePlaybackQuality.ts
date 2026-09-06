import { appStore$, safelyUseCurrentPlayer, telemetry } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import type { VideoPlayer } from 'expo-video'
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import {
  createPlaybackQualityPolicy,
  playbackSize,
} from '../../../../../../packages/app/src/utils/playbackQualityPolicy'
import { BondfireLivePublisher } from '../../../../modules/bondfire-live-publisher'

// One active playback session owns the policy. Keep heat history across short clips.
const policy = createPlaybackQualityPolicy()

export function usePlaybackQuality(
  player: VideoPlayer,
  active: boolean,
  scrubbing: RefObject<boolean>,
  seek: RefObject<{ lastSeekAt: number }>,
) {
  const preference = useValue(appStore$.preferences.playbackQuality) ?? 720

  const playerRef = useRef<VideoPlayer | null>(player)
  playerRef.current = player
  // Clear before useVideoPlayer's passive cleanup releases the native object.
  useLayoutEffect(
    () => () => {
      if (playerRef.current === player) playerRef.current = null
    },
    [player],
  )

  const preferenceRef = useRef(preference)
  const applyRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    preferenceRef.current = preference
    applyRef.current?.()
  }, [preference])

  useEffect(() => {
    if (!active) return
    let disposed = false
    let thermalInFlight = false
    let hasAdvanced = false
    let lastTime = 0
    let lastUpdateAt = Date.now()
    let advancingUntil = 0
    let ignoreStallsUntil = 0
    const withPlayer = <T>(operation: (current: VideoPlayer) => T) =>
      safelyUseCurrentPlayer(playerRef.current, player, operation)
    let previousStatus = withPlayer((current) => current.status)
    let appliedSize = ''

    const apply = () => {
      if (disposed) return
      withPlayer((current) => {
        const track = current.videoTrack ?? current.availableVideoTracks[0]
        const size = playbackSize(policy.resolution(preferenceRef.current), track?.size)
        const key = `${size.width}x${size.height}`
        if (key === appliedSize) return
        current.maxVideoSize = size
        appliedSize = key
      })
    }

    const sample = async () => {
      if (disposed || thermalInFlight) return
      thermalInFlight = true
      try {
        const state = await BondfireLivePublisher.getThermalState()
        if (disposed) return
        policy.thermal(state.level, Date.now())
        policy.playback(Date.now() < advancingUntil && !scrubbing.current, Date.now())
        apply()
      } catch (error) {
        if (!disposed)
          telemetry.warn('video:quality_failed', 'Could not update playback quality', {
            error: String(error),
          })
      } finally {
        thermalInFlight = false
      }
    }

    applyRef.current = apply
    apply()
    void sample()
    const timer = setInterval(() => void sample(), 10_000)
    const load = player.addListener('sourceLoad', apply)
    const track = player.addListener('videoTrackChange', apply)
    const time = player.addListener('timeUpdate', ({ currentTime }) => {
      const now = Date.now()
      const delta = currentTime - lastTime
      const rate = withPlayer((current) => current.playbackRate)
      if (rate === undefined) return
      const maxDelta = ((now - lastUpdateAt) / 1000) * rate + 2
      if (scrubbing.current || delta < 0 || delta > maxDelta) {
        ignoreStallsUntil = now + 3_000
        advancingUntil = 0
        policy.playback(false, now)
      } else if (delta > 0) {
        hasAdvanced = true
        advancingUntil = now + 2_000
      }
      lastTime = currentTime
      lastUpdateAt = now
    })
    const status = player.addListener('statusChange', ({ status }) => {
      const now = Date.now()
      const bufferAhead = withPlayer((current) => current.bufferedPosition - current.currentTime)
      if (bufferAhead === undefined) return
      if (status === 'loading' && previousStatus !== 'loading') {
        policy.playback(false, now)
        if (
          hasAdvanced &&
          !scrubbing.current &&
          now - seek.current.lastSeekAt >= 3_000 &&
          now >= ignoreStallsUntil &&
          bufferAhead < 1
        )
          policy.stall(now)
        apply()
      }
      previousStatus = status
    })
    const playing = player.addListener('playingChange', ({ isPlaying }) => {
      if (!isPlaying) {
        advancingUntil = 0
        policy.playback(false, Date.now())
      }
    })
    return () => {
      disposed = true
      applyRef.current = null
      policy.playback(false, Date.now())
      clearInterval(timer)
      load.remove()
      track.remove()
      time.remove()
      status.remove()
      playing.remove()
    }
  }, [player, active, scrubbing, seek])
}
