declare module 'mux-embed' {
  type OmitFirstArg<F> = F extends (x: any, ...args: infer P) => infer R
    ? (...args: P) => R
    : never;

  type GenericObject = { [k: string | number | symbol]: any };

  export type Metadata = {
    env_key?: string;
    property_key?: string;
    video_id?: string;
    video_title?: string;
    video_duration?: number;
    video_stream_type?: string;
    video_series?: string;
    viewer_user_id?: string;
    viewer_application_name?: string;
    viewer_device_manufacturer?: string;
    viewer_os_family?: string;
    custom_1?: string;
    custom_2?: string;
    custom_3?: string;
    custom_4?: string;
    custom_5?: string;
    custom_6?: string;
    custom_7?: string;
    custom_8?: string;
    custom_9?: string;
    custom_10?: string;
    player_software?: string;
    player_software_version?: string;
    player_name?: string;
    player_init_time?: number;
    player_playhead_time?: number;
    page_type?: string;
    experiment_name?: string;
    sub_property_id?: string;
  };

  export type Options = {
    debug?: boolean;
    data?: Metadata;
    getPlayheadTime?: () => number;
    emitTranslator?: (...args: any[]) => [any] | [any, any] | null | undefined;
    stateDataTranslator?: (data: any) => any;
  };

  export type ErrorEvent = {
    player_error_code?: string;
    player_error_message?: string;
  };

  export type RenditionChangeEvent = {
    video_source_bitrate?: number;
    video_source_width?: number;
    video_source_height?: number;
  };

  export type OrientationChangeEvent = {
    player_is_fullscreen?: boolean;
    player_height?: number;
    player_width?: number;
  };

  export type AdEvent = {
    ad_id?: string;
    ad_creative_id?: string;
    ad_asset_url?: string;
    ad_tag_url?: string;
    ad_type?: string;
    ad_universal_id?: string;
  };

  export type TimeUpdateEvent = {
    player_playhead_time?: number;
  };

  export type EventParamsMapInternal = {
    playerready: void;
    videochange: Metadata;
    viewstart: void;
    viewend: void;
    play: void;
    playing: void;
    pause: void;
    timeupdate: TimeUpdateEvent;
    seeking: void;
    seeked: void;
    rebufferstart: void;
    rebufferend: void;
    error: ErrorEvent;
    ended: void;
    renditionchange: RenditionChangeEvent;
    orientationchange: OrientationChangeEvent;
    adstart: AdEvent;
    adended: AdEvent;
    aderror: AdEvent;
  };

  export interface MuxOnVideoElement {
    deleted: false;
    destroy: () => void;
    swapElement: (playerId: string) => void;
    emit: OmitFirstArg<typeof emit>;
    addHLSJS: (options: any) => void;
    addDashJS: (options: any) => void;
    removeHLSJS: () => void;
    removeDashJS: () => void;
    updateData: OmitFirstArg<typeof updateData>;
    setEmitTranslator: (emitTranslator: Options['emitTranslator']) => void;
    setStateDataTranslator: (stateDataTranslator: Options['stateDataTranslator']) => void;
    setGetPlayheadTime: (getPlayheadTime: Options['getPlayheadTime']) => void;
    triggerAdRequest?: () => void;
  }

  export interface DeletedMuxOnVideoElement {
    deleted: true;
    destroy: () => void;
    swapElement: () => void;
    emit: () => void;
    addHLSJS: () => void;
    addDashJS: () => void;
    removeHLSJS: () => void;
    removeDashJS: () => void;
    updateData: () => void;
    setEmitTranslator: () => void;
    setStateDataTranslator: () => void;
    setGetPlayheadTime: () => void;
    triggerAdRequest?: () => void;
  }

  export const events: {
    PLAYER_READY: 'playerready';
    VIDEO_CHANGE: 'videochange';
    VIEWSTART: 'viewstart';
    VIEWEND: 'viewend';
    PLAY: 'play';
    PLAYING: 'playing';
    PAUSE: 'pause';
    TIME_UPDATE: 'timeupdate';
    SEEKING: 'seeking';
    SEEKED: 'seeked';
    REBUFFER_START: 'rebufferstart';
    REBUFFER_END: 'rebufferend';
    ERROR: 'error';
    ENDED: 'ended';
    RENDITION_CHANGE: 'renditionchange';
    ORIENTATION_CHANGE: 'orientationchange';
    AD_START: 'adstart';
    AD_ENDED: 'adended';
    AD_ERROR: 'aderror';
  };

  export type PlayerId = string | HTMLMediaElement;

  export function monitor(id: PlayerId, options?: Options): void;
  export function init(id: PlayerId, options?: Options): MuxOnVideoElement;
  export function destroyMonitor(playerId: PlayerId): void;
  export function updateData(playerId: PlayerId, data: Partial<Metadata>): void;

  export function emit<K extends keyof EventParamsMapInternal>(
    playerId: PlayerId,
    type: K,
    payload?: EventParamsMapInternal[K]
  ): void;
}
