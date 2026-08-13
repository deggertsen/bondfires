import { requireOptionalNativeModule } from 'expo-modules-core'
import type { VideoPlayer } from 'expo-video'
import { useEffect, useRef } from 'react'

type RemoteCommand =
  | { command: 'play' }
  | { command: 'pause' }
  | { command: 'seek'; position: number }

type EventSubscription = {
  remove: () => void
}

interface NowPlayingInfoNativeModule {
  setMetadata(artist: string, title: string, album: string, duration: number): Promise<void>
  setPlaybackState(playing: boolean, position: number): Promise<void>
  clearMetadata(): Promise<void>
  addListener(event: 'remoteCommand', listener: (command: RemoteCommand) => void): EventSubscription
}

export interface UseNowPlayingInfoOptions {
  videoOwnerName?: string | null
  campName?: string | null
  bondfireTitle?: string | null
  player?: VideoPlayer | null
  isActive: boolean
}

const nowPlayingInfo = requireOptionalNativeModule<NowPlayingInfoNativeModule>('NowPlayingInfo')

// Multiple feed pages stay mounted around the visible page. Track which hook
// owns the native session so an inactive neighbor can never clear the active
// video's metadata during FlatList window updates.
let activeMetadataOwner: symbol | null = null

function safeMediaTime(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizedText(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim()
  return normalized || fallback
}

function runNativeCall(call: () => Promise<void>) {
  void call().catch(() => undefined)
}

/**
 * Publishes the visible expo-video player to the platform Now Playing center
 * and routes Bluetooth/headset transport commands back to that player.
 */
export function useNowPlayingInfo({
  videoOwnerName,
  campName,
  bondfireTitle,
  player,
  isActive,
}: UseNowPlayingInfoOptions) {
  const ownerRef = useRef(Symbol('now-playing-owner'))

  useEffect(() => {
    if (!nowPlayingInfo || !player || !isActive) return

    const owner = ownerRef.current
    const artist = normalizedText(videoOwnerName, 'Unknown')
    const album = normalizedText(campName, 'Bondfires')
    const title = normalizedText(bondfireTitle, `${artist}'s Bondfire`)

    activeMetadataOwner = owner

    const ownsMetadata = () => activeMetadataOwner === owner
    const updateMetadata = (duration: number) => {
      if (!ownsMetadata()) return
      runNativeCall(() => nowPlayingInfo.setMetadata(artist, title, album, safeMediaTime(duration)))
    }
    const updatePlaybackState = (playing: boolean, position: number) => {
      if (!ownsMetadata()) return
      runNativeCall(() => nowPlayingInfo.setPlaybackState(playing, safeMediaTime(position)))
    }

    updateMetadata(player.duration)
    updatePlaybackState(player.playing, player.currentTime)

    const sourceLoadSubscription = player.addListener('sourceLoad', ({ duration }) => {
      updateMetadata(duration)
    })
    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      updatePlaybackState(isPlaying, player.currentTime)
    })
    const timeUpdateSubscription = player.addListener('timeUpdate', ({ currentTime }) => {
      updatePlaybackState(player.playing, currentTime)
    })
    const remoteCommandSubscription = nowPlayingInfo.addListener('remoteCommand', (event) => {
      if (!ownsMetadata()) return

      if (event.command === 'play') {
        player.play()
        return
      }

      if (event.command === 'pause') {
        player.pause()
        return
      }

      const requestedPosition = safeMediaTime(event.position)
      const duration = safeMediaTime(player.duration)
      player.currentTime = duration > 0 ? Math.min(requestedPosition, duration) : requestedPosition
      updatePlaybackState(player.playing, player.currentTime)
    })

    return () => {
      sourceLoadSubscription.remove()
      playingSubscription.remove()
      timeUpdateSubscription.remove()
      remoteCommandSubscription.remove()

      if (ownsMetadata()) {
        activeMetadataOwner = null
        runNativeCall(() => nowPlayingInfo.clearMetadata())
      }
    }
  }, [bondfireTitle, campName, isActive, player, videoOwnerName])
}
