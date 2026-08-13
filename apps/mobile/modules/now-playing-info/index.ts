import { requireOptionalNativeModule } from 'expo-modules-core'

export type NowPlayingRemoteCommand =
  | { command: 'play' }
  | { command: 'pause' }
  | { command: 'seek'; position: number }

export type NowPlayingInfoSubscription = {
  remove: () => void
}

export interface NowPlayingInfoNativeModule {
  setMetadata(artist: string, title: string, album: string, duration: number): Promise<void>
  setPlaybackState(playing: boolean, position: number): Promise<void>
  clearMetadata(): Promise<void>
  addListener(
    event: 'remoteCommand',
    listener: (command: NowPlayingRemoteCommand) => void,
  ): NowPlayingInfoSubscription
}

export const NowPlayingInfo =
  requireOptionalNativeModule<NowPlayingInfoNativeModule>('NowPlayingInfo')
