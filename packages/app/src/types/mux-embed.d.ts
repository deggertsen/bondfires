declare module 'mux-embed' {
  export type Metadata = {
    env_key?: string
    player_is_paused?: boolean
    player_name?: string
    player_playhead_time?: number
    player_software_name?: string
    player_software_version?: string
    player_mux_plugin_name?: string
    player_mux_plugin_version?: string
    video_id?: string
    video_title?: string
    video_duration?: number
    video_stream_type?: string
    video_series?: string
    video_source_duration?: number
    video_source_is_live?: boolean
    video_source_url?: string
    viewer_application_name?: string
    viewer_user_id?: string
    custom_1?: string
    custom_2?: string
    custom_3?: string
  }

  export type PlatformData = {
    name?: string
    manufacturer?: string
    os?: {
      family?: string
      version?: string
    }
  }

  export type Options = {
    debug?: boolean
    data?: Metadata
    getPlayheadTime?: () => number
    getStateData?: () => Metadata
    platform?: PlatformData
  }

  export type ErrorEvent = {
    player_error_code?: string
    player_error_message?: string
  }

  export type TimeUpdateEvent = {
    player_playhead_time?: number
  }

  export type EventParamsMap = {
    playerready: void
    videochange: Metadata
    play: void
    playing: void
    pause: void
    timeupdate: TimeUpdateEvent
    rebufferstart: void
    rebufferend: void
    error: ErrorEvent
    ended: void
    destroy: void
  }

  export type Events = {
    PLAYER_READY: 'playerready'
    VIDEO_CHANGE: 'videochange'
    PLAY: 'play'
    PLAYING: 'playing'
    PAUSE: 'pause'
    TIME_UPDATE: 'timeupdate'
    REBUFFER_START: 'rebufferstart'
    REBUFFER_END: 'rebufferend'
    ERROR: 'error'
    ENDED: 'ended'
    DESTROY: 'destroy'
  }

  export type MuxEmbed = {
    init(playerId: string, options: Options): void
    emit<K extends keyof EventParamsMap>(
      playerId: string,
      event: K,
      payload?: EventParamsMap[K],
    ): void
    updateData(playerId: string, data: Metadata): void
    events: Events
  }

  const mux: MuxEmbed
  export default mux
}
