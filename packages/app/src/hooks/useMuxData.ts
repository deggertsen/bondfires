/// <reference path="../types/mux-embed.d.ts" />

import mux, { type Metadata } from 'mux-embed'
import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'

type VideoPlayer = import('expo-video').VideoPlayer

const MUX_DATA_ENV_KEY = (
  process.env as Record<string, string | undefined>
).EXPO_PUBLIC_MUX_DATA_ENV_KEY?.trim()

const EXPO_VIDEO_VERSION = '3.0.15'
const TIME_UPDATE_INTERVAL_SECONDS = 0.25

export interface MuxDataVideoMetadata {
  video_id: string
  video_title?: string
  video_duration?: number
  video_stream_type?: 'live' | 'on-demand'
  video_series?: string
  custom_1?: string
  custom_2?: string
  custom_3?: string
}

export interface MuxDataViewerMetadata {
  viewer_user_id?: string
}

interface UseMuxDataOptions {
  player: VideoPlayer | undefined
  sourceUrl: string | null
  videoMetadata: MuxDataVideoMetadata | null
  viewerMetadata?: MuxDataViewerMetadata
  isActive: boolean
}

function secondsToMs(seconds: number | undefined) {
  return Math.round((seconds ?? 0) * 1000)
}

function videoDurationMs(player: VideoPlayer | undefined) {
  if (!player?.duration || !Number.isFinite(player.duration)) {
    return undefined
  }

  return secondsToMs(player.duration)
}

function buildMonitorId(videoId: string) {
  return `bondfires-video-${videoId}`
}

/**
 * Bridges expo-video events into Mux Data using mux-embed's custom player API.
 */
export function useMuxData({
  player,
  sourceUrl,
  videoMetadata,
  viewerMetadata,
  isActive,
}: UseMuxDataOptions) {
  const monitorIdRef = useRef<string | null>(null)
  const playerRef = useRef<VideoPlayer | undefined>(player)
  const sourceUrlRef = useRef<string | null>(sourceUrl)
  const isActiveRef = useRef(isActive)
  const videoMetadataRef = useRef<MuxDataVideoMetadata | null>(videoMetadata)
  const lastPlayingRef = useRef(false)
  const playerReadyEmittedRef = useRef(false)
  const rebufferingRef = useRef(false)
  const videoId = videoMetadata?.video_id
  const hasSourceUrl = Boolean(sourceUrl)

  playerRef.current = player
  sourceUrlRef.current = sourceUrl
  isActiveRef.current = isActive
  videoMetadataRef.current = videoMetadata

  useEffect(() => {
    const currentVideoMetadata = videoMetadataRef.current
    const currentSourceUrl = sourceUrlRef.current

    if (
      !MUX_DATA_ENV_KEY ||
      !player ||
      !videoId ||
      !currentVideoMetadata ||
      !hasSourceUrl ||
      !currentSourceUrl ||
      !isActive
    ) {
      return
    }

    const monitorId = buildMonitorId(videoId)
    monitorIdRef.current = monitorId
    lastPlayingRef.current = false
    playerReadyEmittedRef.current = false
    rebufferingRef.current = false

    const getPlayheadTime = () => secondsToMs(playerRef.current?.currentTime)

    const getStateData = (): Metadata => {
      const currentPlayer = playerRef.current
      const currentVideoMetadata = videoMetadataRef.current
      const currentDuration = currentVideoMetadata?.video_duration ?? videoDurationMs(currentPlayer)

      return {
        player_is_paused:
          !isActiveRef.current || !currentPlayer?.playing || currentPlayer.status !== 'readyToPlay',
        player_playhead_time: getPlayheadTime(),
        video_source_url: sourceUrlRef.current ?? undefined,
        video_source_duration: currentDuration,
        video_source_is_live: currentVideoMetadata?.video_stream_type === 'live',
      }
    }

    mux.init(monitorId, {
      debug: false,
      getPlayheadTime,
      getStateData,
      data: {
        env_key: MUX_DATA_ENV_KEY,
        player_software_name: 'expo-video',
        player_software_version: EXPO_VIDEO_VERSION,
        player_mux_plugin_name: 'bondfires-expo-video',
        player_mux_plugin_version: '1.0.0',
        player_name: 'Bondfires VideoPlayer',
        viewer_application_name: 'Bondfires',
        viewer_user_id: viewerMetadata?.viewer_user_id,
        video_id: currentVideoMetadata.video_id,
        video_title: currentVideoMetadata.video_title,
        video_duration: currentVideoMetadata.video_duration,
        video_stream_type: currentVideoMetadata.video_stream_type ?? 'on-demand',
        video_series: currentVideoMetadata.video_series,
        video_source_url: currentSourceUrl,
        video_source_duration: currentVideoMetadata.video_duration ?? videoDurationMs(player),
        custom_1: currentVideoMetadata.custom_1,
        custom_2: currentVideoMetadata.custom_2,
        custom_3: currentVideoMetadata.custom_3,
      },
      platform: {
        name: 'Bondfires',
        manufacturer: Platform.OS === 'ios' ? 'Apple' : undefined,
        os: {
          family: Platform.OS,
          version: String(Platform.Version),
        },
      },
    })

    if (player.status === 'readyToPlay') {
      mux.emit(monitorId, mux.events.PLAYER_READY)
      playerReadyEmittedRef.current = true
    }

    if (player.playing) {
      mux.emit(monitorId, mux.events.PLAY)
      mux.emit(monitorId, mux.events.PLAYING)
      lastPlayingRef.current = true
    }

    const previousTimeUpdateInterval = player.timeUpdateEventInterval
    player.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_SECONDS

    const statusSubscription = player.addListener('statusChange', (status) => {
      if (monitorIdRef.current !== monitorId) return

      if (status.status === 'readyToPlay') {
        if (!playerReadyEmittedRef.current) {
          mux.emit(monitorId, mux.events.PLAYER_READY)
          playerReadyEmittedRef.current = true
        }

        if (rebufferingRef.current) {
          mux.emit(monitorId, mux.events.REBUFFER_END)
          rebufferingRef.current = false
        }

        const duration = videoDurationMs(player)
        if (duration) {
          mux.updateData(monitorId, {
            video_duration: duration,
            video_source_duration: duration,
          })
        }
      } else if (status.status === 'loading' && lastPlayingRef.current) {
        mux.emit(monitorId, mux.events.REBUFFER_START)
        rebufferingRef.current = true
      } else if (status.status === 'error') {
        const message = status.error?.message ?? 'expo-video playback error'
        mux.emit(monitorId, mux.events.ERROR, {
          player_error_code: message,
          player_error_message: message,
        })
      }
    })

    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      if (monitorIdRef.current !== monitorId) return

      if (isPlaying && isActiveRef.current) {
        mux.emit(monitorId, mux.events.PLAY)
        mux.emit(monitorId, mux.events.PLAYING)
      } else {
        mux.emit(monitorId, mux.events.PAUSE)
      }

      lastPlayingRef.current = isPlaying
    })

    const timeUpdateSubscription = player.addListener('timeUpdate', ({ currentTime }) => {
      if (monitorIdRef.current !== monitorId) return

      mux.emit(monitorId, mux.events.TIME_UPDATE, {
        player_playhead_time: secondsToMs(currentTime),
      })
    })

    const endSubscription = player.addListener('playToEnd', () => {
      if (monitorIdRef.current !== monitorId) return

      mux.emit(monitorId, mux.events.ENDED)
      lastPlayingRef.current = false
    })

    return () => {
      statusSubscription.remove()
      playingSubscription.remove()
      timeUpdateSubscription.remove()
      endSubscription.remove()
      player.timeUpdateEventInterval = previousTimeUpdateInterval

      if (monitorIdRef.current === monitorId) {
        mux.emit(monitorId, mux.events.DESTROY)
        monitorIdRef.current = null
      }
    }
  }, [player, isActive, videoId, hasSourceUrl, viewerMetadata?.viewer_user_id])

  useEffect(() => {
    const monitorId = monitorIdRef.current
    if (!monitorId || !videoMetadata || !sourceUrl) {
      return
    }

    mux.updateData(monitorId, {
      viewer_user_id: viewerMetadata?.viewer_user_id,
      video_id: videoMetadata.video_id,
      video_title: videoMetadata.video_title,
      video_duration: videoMetadata.video_duration ?? videoDurationMs(player),
      video_stream_type: videoMetadata.video_stream_type ?? 'on-demand',
      video_series: videoMetadata.video_series,
      video_source_url: sourceUrl,
      video_source_duration: videoMetadata.video_duration ?? videoDurationMs(player),
      custom_1: videoMetadata.custom_1,
      custom_2: videoMetadata.custom_2,
      custom_3: videoMetadata.custom_3,
    })
  }, [player, sourceUrl, videoMetadata, viewerMetadata?.viewer_user_id])
}
