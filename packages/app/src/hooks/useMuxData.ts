import mux from 'mux-embed'
import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'

type VideoPlayer = import('expo-video').VideoPlayer

/**
 * Video-level metadata sent to MUX Data.
 * All fields are optional except env_key (set globally via init) and video_id.
 */
export interface MuxDataVideoMetadata {
  /** MUX playback ID (required for MUX-hosted video correlation) */
  video_id: string
  /** Human-readable video title */
  video_title?: string
  /** Video duration in milliseconds */
  video_duration?: number
  /** Whether this is a live stream */
  video_stream_type?: 'live' | 'on-demand'
  /** Content series or category (e.g. bondfire ID) */
  video_series?: string
  /** Custom metadata fields */
  custom_1?: string // creator name
  custom_2?: string // bondfire / response context
  custom_3?: string // isMainVideo
}

/**
 * Viewer-level metadata.
 */
export interface MuxDataViewerMetadata {
  /** Unique identifier for the viewer */
  viewer_user_id?: string
}

interface UseMuxDataOptions {
  /** The expo-video VideoPlayer instance */
  player: VideoPlayer | undefined
  /** Video metadata — changes trigger a new view */
  videoMetadata: MuxDataVideoMetadata | null
  /** Viewer metadata */
  viewerMetadata?: MuxDataViewerMetadata
  /** Whether video is currently active (visible + focused) */
  isActive: boolean
}

/**
 * Bridges expo-video's VideoPlayer events into MUX Data for QoE monitoring.
 *
 * Uses mux-embed's `init()` (generic player monitor) and manually emits
 * playback events based on expo-video's `statusChange`, `playToEnd`,
 * `timeUpdate`, and other listeners.
 *
 * MUX Data is included free for all MUX-hosted video streams.
 * This hook requires the env key to be set via `EXPO_PUBLIC_MUX_DATA_ENV_KEY`.
 */
export function useMuxData({ player, videoMetadata, viewerMetadata, isActive }: UseMuxDataOptions) {
  const monitorRef = useRef<mux.MuxOnVideoElement | mux.DeletedMuxOnVideoElement | null>(null)
  const envKeyRef = useRef<string | null>(null)
  const initialLoadRef = useRef<number>(Date.now())
  const lastProgressRef = useRef<number>(0)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasStartedViewRef = useRef(false)

  // Lazily initialize the env key (read once from process.env at runtime)
  if (!envKeyRef.current) {
    // In Expo, EXPO_PUBLIC_ vars are inlined at build time as process.env.EXPO_PUBLIC_*
    envKeyRef.current =
      (process.env as Record<string, string | undefined>).EXPO_PUBLIC_MUX_DATA_ENV_KEY ?? null
  }

  const envKey = envKeyRef.current

  // Initialize/destroy the monitor based on whether we have everything we need
  useEffect(() => {
    if (!envKey || !videoMetadata) {
      // Clean up existing monitor if metadata goes away
      if (monitorRef.current && !monitorRef.current.deleted) {
        monitorRef.current.destroy()
        monitorRef.current = null
      }
      return
    }

    const monitorId = `bondfires-video-${videoMetadata.video_id}`

    // If we already have a monitor with a different ID, destroy it
    if (monitorRef.current && !monitorRef.current.deleted) {
      monitorRef.current.destroy()
      monitorRef.current = null
    }

    hasStartedViewRef.current = false
    lastProgressRef.current = 0

    // Create a new monitor using init() for generic player
    // init() doesn't require an HTML element — it creates a generic monitor
    const monitor = mux.init(monitorId, {
      debug: false,
      data: {
        env_key: envKey,
        player_software: 'expo-video',
        player_software_version: '3.0.15',
        player_name: 'Bondfires VideoPlayer',
        video_id: videoMetadata.video_id,
        video_title: videoMetadata.video_title,
        video_duration: videoMetadata.video_duration,
        video_stream_type: videoMetadata.video_stream_type ?? 'on-demand',
        video_series: videoMetadata.video_series,
        viewer_user_id: viewerMetadata?.viewer_user_id,
        viewer_application_name: 'Bondfires',
        viewer_device_manufacturer: Platform.select({ ios: 'Apple', default: undefined }),
        viewer_os_family: Platform.OS,
        custom_1: videoMetadata.custom_1,
        custom_2: videoMetadata.custom_2,
        custom_3: videoMetadata.custom_3,
      },
    })

    // Emit the view start event to begin tracking
    mux.emit(monitorId, mux.events.VIEWSTART)
    hasStartedViewRef.current = true

    initialLoadRef.current = Date.now()
    monitorRef.current = monitor

    return () => {
      // Clear progress interval
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
        progressIntervalRef.current = null
      }

      if (monitor && !monitor.deleted) {
        mux.emit(monitorId, mux.events.ENDED)
        mux.emit(monitorId, mux.events.VIEWEND)
        monitor.destroy()
        monitorRef.current = null
      }
    }
  }, [envKey, videoMetadata, viewerMetadata?.viewer_user_id])

  // Track playback events from the VideoPlayer
  useEffect(() => {
    if (!player || !monitorRef.current || monitorRef.current.deleted || !videoMetadata || !envKey) {
      return
    }

    const monitorId = `bondfires-video-${videoMetadata.video_id}`

    // Track status changes (ready, playing, buffering, error)
    const statusSub = player.addListener('statusChange', (status) => {
      if (!hasStartedViewRef.current) return

      switch (status.status) {
        case 'readyToPlay': {
          mux.emit(monitorId, mux.events.PLAYER_READY)
          // If player is already playing when ready, emit playing
          if (player.playing) {
            mux.emit(monitorId, mux.events.PLAYING)
          }
          break
        }
        case 'loading': {
          // MUX considers buffering when loading during active playback
          if (player.playing) {
            mux.emit(monitorId, mux.events.REBUFFER_START)
          }
          break
        }
        case 'error': {
          const errMsg = status.error?.message ?? ''
          mux.emit(monitorId, mux.events.ERROR, {
            player_error_code: errMsg,
            player_error_message: errMsg,
          })
          break
        }
      }
    })

    // Track play-to-end
    const endSub = player.addListener('playToEnd', () => {
      if (!hasStartedViewRef.current) return
      mux.emit(monitorId, mux.events.ENDED)
    })

    // Track time updates — emit TIME_UPDATE periodically
    // expo-video doesn't have a timeUpdate event, so we use an interval
    progressIntervalRef.current = setInterval(() => {
      if (!hasStartedViewRef.current) return
      if (!player || player.status !== 'readyToPlay') return

      const currentTime = player.currentTime
      if (currentTime === undefined) return

      const playheadMs = currentTime * 1000
      lastProgressRef.current = playheadMs

      mux.emit(monitorId, mux.events.TIME_UPDATE, {
        player_playhead_time: playheadMs,
      })
    }, 250)

    return () => {
      statusSub.remove()
      endSub.remove()
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
        progressIntervalRef.current = null
      }
    }
  }, [player, videoMetadata, envKey])

  // Track play/pause state changes based on isActive and player status
  useEffect(() => {
    if (!player || !monitorRef.current || monitorRef.current.deleted || !videoMetadata || !envKey) {
      return
    }

    if (!hasStartedViewRef.current) return

    const monitorId = `bondfires-video-${videoMetadata.video_id}`

    if (isActive && player.playing && player.status === 'readyToPlay') {
      mux.emit(monitorId, mux.events.PLAYING)
    } else if (!isActive || !player.playing) {
      mux.emit(monitorId, mux.events.PAUSE)
    }
  }, [isActive, player, videoMetadata, envKey])

  // Update video duration when it becomes available
  useEffect(() => {
    if (
      !player ||
      !monitorRef.current ||
      monitorRef.current.deleted ||
      !videoMetadata ||
      !envKey ||
      !player.duration
    ) {
      return
    }

    const monitorId = `bondfires-video-${videoMetadata.video_id}`
    mux.updateData(monitorId, {
      video_duration: player.duration * 1000,
    })
  }, [player, player?.duration, videoMetadata, envKey])
}
