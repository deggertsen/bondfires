import {
  appActions,
  appStore$,
  getBondfireVideoIndex,
  hasViewedToday,
  type MuxDataVideoMetadata,
  markViewed,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  telemetry,
  useMuxData,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useObserveEffect, useValue } from '@legendapp/state/react'
import { useIsFocused, useNavigation } from '@react-navigation/native'
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Flame,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { LinearGradient } from 'expo-linear-gradient'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  Dimensions,
  FlatList,
  type LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  StatusBar,
  View,
  type ViewToken,
} from 'react-native'
import { Sheet, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { InviteSheet } from '../../../components/InviteSheet'
import { NotepadOverlay } from '../../../components/NotepadOverlay'
import { ReportButton } from '../../../components/ReportButton'
import { ReportOverlay } from '../../../components/ReportOverlay'
import { SettingsPopover } from '../../../components/SettingsPopover'
import { routes } from '../../../lib/routes'

const { width: SCREEN_WIDTH } = Dimensions.get('window')

type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

type BondfireDetailData = Doc<'bondfires'> & {
  campStatus?: Doc<'camps'>['status']
  videos: Doc<'bondfireVideos'>[]
  participants?: ThreadParticipant[]
}

type ProgressBarMetrics = {
  width: number
  pageX: number | null
}

interface VideoPlayerProps {
  // Exactly one of these must be provided
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  videoUrl: string | null
  videoUrlSd: string | null
  videoOwnerId: Id<'users'>
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  onComplete: () => void
  onProgress: (progress: number) => void
  creatorName: string
  isMainVideo: boolean
  responseIndex?: number
  isLive?: boolean
}

function VideoPlayer({
  bondfireId,
  bondfireVideoId,
  videoUrl,
  videoUrlSd,
  videoOwnerId,
  isActive,
  isScreenFocused,
  isAppActive,
  onComplete,
  onProgress,
  creatorName,
  isMainVideo,
  responseIndex,
  isLive = false,
}: VideoPlayerProps) {
  // Get the video ID for internal use (keep-awake tag, etc.)
  const videoId = bondfireId || bondfireVideoId || ''
  const autoplayVideos = useValue(appStore$.preferences.autoplayVideos)
  const videoQuality = useValue(appStore$.preferences.videoQuality)
  const isMuted = useValue(appStore$.preferences.videoMuted)
  const currentUserId = useValue(appStore$.userId)
  const shouldSuppressPlayback = isLive && currentUserId === videoOwnerId

  // Determine URL based on quality preference and foreground state.
  const getTargetUrl = useCallback(() => {
    if (shouldSuppressPlayback) {
      return null
    }

    if (!isActive || !isScreenFocused || !isAppActive) {
      return videoUrlSd ?? videoUrl
    }

    if (videoQuality === 'sd' && videoUrlSd) return videoUrlSd
    return videoUrl // HD or auto starts with HD
  }, [
    isActive,
    isScreenFocused,
    isAppActive,
    videoQuality,
    videoUrl,
    videoUrlSd,
    shouldSuppressPlayback,
  ])

  const state$ = useObservable({
    showReport: false,
    currentUrl: getTargetUrl(),
    hasSwitchedToSD: false,
    progress: 0,
    duration: 0,
    isLoading: true,
    userInitiatedPlay: false,
    hasEnded: false,
  })

  const showReport = useValue(state$.showReport)
  const currentUrl = useValue(state$.currentUrl)
  const progress = useValue(state$.progress)
  const duration = useValue(state$.duration)
  const isLoading = useValue(state$.isLoading)
  const hasEnded = useValue(state$.hasEnded)

  const bufferingCheckInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const progressBarViewRef = useRef<View>(null)
  const progressBarRef = useRef<ProgressBarMetrics>({ width: 0, pageX: null })

  const player = useVideoPlayer(currentUrl || '', (player) => {
    player.loop = false
    player.muted = isMuted
    player.playbackRate = appStore$.preferences.playbackSpeed.get()
    player.preservesPitch = true
  })

  // Extract MUX playback ID from the video URL for Data tracking
  const muxPlaybackId = useMemo(() => {
    if (!videoUrl) return null
    const match = videoUrl.match(/stream\.mux\.com\/([^/?#]+)\.m3u8(?:[?#]|$)/)
    return match ? match[1] : null
  }, [videoUrl])

  // MUX Data tracking (included free for MUX-hosted video)
  const muxDataVideoMetadata: MuxDataVideoMetadata | null = useMemo(() => {
    if (!muxPlaybackId) return null
    return {
      video_id: muxPlaybackId,
      video_title: creatorName
        ? isMainVideo
          ? `${creatorName}'s Spark`
          : `${creatorName}'s Response #${(responseIndex ?? 0) + 1}`
        : undefined,
      video_stream_type: isLive ? 'live' : 'on-demand',
      video_series: bondfireId,
      custom_1: creatorName,
      custom_2: isMainVideo ? 'spark' : 'response',
      custom_3: isMainVideo ? 'true' : 'false',
    }
  }, [muxPlaybackId, creatorName, isMainVideo, responseIndex, isLive, bondfireId])

  useMuxData({
    player,
    sourceUrl: currentUrl,
    videoMetadata: muxDataVideoMetadata,
    viewerMetadata: useMemo(
      () => ({ viewer_user_id: currentUserId ?? undefined }),
      [currentUserId],
    ),
    isActive: isActive && isScreenFocused && isAppActive,
  })

  // Update playback speed only for the active, foreground player.
  // This prevents rate changes from mutating all mounted players in the response chain.
  useObserveEffect(() => {
    if (player && isActive && isScreenFocused && isAppActive) {
      player.playbackRate = appStore$.preferences.playbackSpeed.get()
    }
  })

  // Update mute state when preference changes (effect phase for player mutations)
  useObserveEffect(() => {
    if (player) {
      player.muted = appStore$.preferences.videoMuted.get()
    }
  })

  // Play/pause based on isActive, screen focus, and app state
  useEffect(() => {
    if (!player) return

    // Only play if video is active, screen is focused, AND app is in foreground
    const shouldPlay = isActive && isScreenFocused && isAppActive && !shouldSuppressPlayback

    if (shouldPlay) {
      player.playbackRate = appStore$.preferences.playbackSpeed.get()
      // Only auto-play if autoplay is enabled OR user has manually initiated play
      if (autoplayVideos || state$.userInitiatedPlay.get()) {
        player.play()
      }
    } else {
      player.pause()
      // Reset user-initiated play when video becomes inactive
      if (!isActive) {
        state$.userInitiatedPlay.set(false)
      }
    }
  }, [
    player,
    isActive,
    isScreenFocused,
    isAppActive,
    autoplayVideos,
    state$,
    shouldSuppressPlayback,
  ])

  // Monitor playback status (external subscriptions - keep useEffect)
  useEffect(() => {
    if (!player) return

    const statusSubscription = player.addListener('statusChange', (status) => {
      if (status.status === 'readyToPlay') {
        state$.isLoading.set(false)
        // Get duration from player, not status event
        if (player.duration) {
          state$.duration.set(player.duration * 1000) // Convert to milliseconds
        }
      } else if (status.status === 'loading') {
        state$.isLoading.set(true)
      }

      // Update progress when status changes to readyToPlay
      if (status.status === 'readyToPlay') {
        if (!isLive && player.currentTime !== undefined && player.duration) {
          const currentProgress = player.currentTime / player.duration
          state$.progress.set(currentProgress)
          onProgress(currentProgress)

          if (player.currentTime >= player.duration - 0.1) {
            onComplete()
          }
        }
      }
    })

    // Listen for video end
    const endSubscription = player.addListener('playToEnd', () => {
      state$.hasEnded.set(true)
      state$.progress.set(1)
      onComplete()
    })

    // Update progress periodically (interval-based)
    const progressInterval = setInterval(() => {
      if (
        !isLive &&
        player.status === 'readyToPlay' &&
        player.currentTime !== undefined &&
        player.duration
      ) {
        const currentProgress = player.currentTime / player.duration
        state$.progress.set(currentProgress)
        onProgress(currentProgress)
      }
    }, 100)

    return () => {
      statusSubscription.remove()
      endSubscription.remove()
      clearInterval(progressInterval)
    }
  }, [player, onComplete, onProgress, state$, isLive])

  // Buffering detection - switch to SD if buffer is low (only in auto mode)
  useEffect(() => {
    // Only apply adaptive quality switching in 'auto' mode
    if (videoQuality !== 'auto') return
    if (!isActive || !isScreenFocused || !isAppActive) return
    const hasSwitchedToSD = state$.hasSwitchedToSD.get()
    const currentUrlValue = state$.currentUrl.get()
    if (!videoUrlSd || hasSwitchedToSD || !currentUrlValue || currentUrlValue !== videoUrl) {
      return
    }

    bufferingCheckInterval.current = setInterval(() => {
      if (!player || state$.hasSwitchedToSD.get()) return

      // Check if player is buffering and we have SD available
      if (
        !isLive &&
        player.status === 'loading' &&
        player.currentTime !== undefined &&
        player.duration
      ) {
        const remaining = player.duration - player.currentTime
        // Switch to SD if buffering and more than 5 seconds remaining
        if (remaining > 5) {
          state$.currentUrl.set(videoUrlSd)
          state$.hasSwitchedToSD.set(true)
        }
      }
    }, 1000)

    return () => {
      if (bufferingCheckInterval.current) {
        clearInterval(bufferingCheckInterval.current)
      }
    }
  }, [
    player,
    videoUrlSd,
    videoUrl,
    videoQuality,
    isActive,
    isScreenFocused,
    isAppActive,
    state$,
    isLive,
  ])

  // Update URL when video quality preference, source URLs, or foreground state change.
  useEffect(() => {
    const targetUrl = getTargetUrl()

    const currentUrlValue = state$.currentUrl.get()
    if (targetUrl && currentUrlValue !== targetUrl) {
      state$.currentUrl.set(targetUrl)
      // Only reset hasSwitchedToSD when preference changes or new video
      if (videoQuality !== 'auto') {
        state$.hasSwitchedToSD.set(false)
      }
    }
  }, [getTargetUrl, videoQuality, state$])

  // Keep screen awake while video is playing
  const isPlaying = player?.playing ?? false
  const keepAwakeTag = `video-playback-${videoId}`
  useEffect(() => {
    if (isScreenFocused && isAppActive && isActive && isPlaying) {
      activateKeepAwakeAsync(keepAwakeTag)
    } else {
      deactivateKeepAwake(keepAwakeTag)
    }

    return () => {
      deactivateKeepAwake(keepAwakeTag)
    }
  }, [isScreenFocused, isAppActive, isActive, isPlaying, keepAwakeTag])

  const togglePlayPause = useCallback(() => {
    if (!player) return

    if (state$.hasEnded.get()) {
      // Replay from beginning
      player.replay()
      state$.hasEnded.set(false)
      state$.userInitiatedPlay.set(true)
    } else if (player.playing) {
      player.pause()
    } else {
      // User manually initiated play
      state$.userInitiatedPlay.set(true)
      player.play()
    }
  }, [player, state$])

  const toggleMute = useCallback(() => {
    if (!player) return
    appActions.setVideoMuted(!appStore$.preferences.videoMuted.get())
  }, [player])

  const handleProgressBarLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout
    progressBarRef.current.width = width
    progressBarViewRef.current?.measure((_x, _y, measuredWidth, _height, pageX) => {
      progressBarRef.current = { width: measuredWidth || width, pageX }
    })
  }, [])

  const seekToProgressLocation = useCallback(
    (locationX: number) => {
      if (!player || isLive) return

      const videoDuration = player.duration
      if (!Number.isFinite(videoDuration) || videoDuration <= 0) return

      const { width } = progressBarRef.current

      if (width > 0) {
        const seekProgress = Math.max(0, Math.min(1, locationX / width))
        const seekTime = seekProgress * videoDuration
        player.currentTime = seekTime
        state$.progress.set(seekProgress)
        state$.hasEnded.set(false)
        state$.userInitiatedPlay.set(true)
      }
    },
    [player, state$, isLive],
  )

  const canSeekProgress =
    !isLive && Number.isFinite(player?.duration) && (player?.duration ?? 0) > 0
  const canSeekProgressRef = useRef(canSeekProgress)
  const seekToProgressLocationRef = useRef(seekToProgressLocation)

  canSeekProgressRef.current = canSeekProgress
  seekToProgressLocationRef.current = seekToProgressLocation

  const seekToProgressPageX = useCallback((pageX: number) => {
    const barPageX = progressBarRef.current.pageX
    if (barPageX === null) return

    seekToProgressLocationRef.current(pageX - barPageX)
  }, [])

  const measureProgressBar = useCallback((onMeasured?: () => void) => {
    progressBarViewRef.current?.measure((_x, _y, width, _height, pageX) => {
      progressBarRef.current = { width: width || progressBarRef.current.width, pageX }
      onMeasured?.()
    })
  }, [])

  useLayoutEffect(() => {
    if (!isLive) {
      measureProgressBar()
    }
  }, [isLive, measureProgressBar])

  const progressBarPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => canSeekProgressRef.current,
      onMoveShouldSetPanResponder: () => canSeekProgressRef.current,

      onPanResponderGrant: (evt) => {
        const touchPageX = evt.nativeEvent.pageX
        measureProgressBar(() => {
          seekToProgressPageX(touchPageX)
        })
      },

      onPanResponderMove: (_evt, gestureState) => {
        seekToProgressPageX(gestureState.moveX)
      },
    }),
  ).current

  if (shouldSuppressPlayback) {
    return (
      <YStack
        flex={1}
        width={SCREEN_WIDTH}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        gap={14}
      >
        <YStack
          backgroundColor={bondfireColors.error}
          paddingHorizontal={16}
          paddingVertical={8}
          borderRadius={16}
        >
          <Text color={bondfireColors.whiteSmoke} fontWeight="900" fontSize={13}>
            LIVE
          </Text>
        </YStack>
        <Text color={bondfireColors.whiteSmoke} fontSize={22} fontWeight="900">
          You are live
        </Text>
        <Text color={bondfireColors.ash} fontSize={14}>
          Your replay will appear here after Mux finishes saving it.
        </Text>
      </YStack>
    )
  }

  return (
    <YStack flex={1} width={SCREEN_WIDTH} backgroundColor={bondfireColors.obsidian}>
      {currentUrl && player ? (
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="cover"
          nativeControls={false}
          surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
        />
      ) : (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={bondfireColors.bondfireCopper} />
        </YStack>
      )}

      {/* Touch overlay for play/pause/replay — positioned ABOVE VideoView so it receives taps first */}
      <Pressable
        onPress={togglePlayPause}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1,
        }}
      />

      {/* Loading overlay */}
      {isLoading && currentUrl && (
        <YStack
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="center"
          justifyContent="center"
          backgroundColor="rgba(20, 20, 22, 0.7)"
          zIndex={2}
          pointerEvents="none"
        >
          <Spinner size="large" color={bondfireColors.bondfireCopper} />
        </YStack>
      )}

      {/* Play/Pause/Replay indicator */}
      {!isPlaying && !isLoading && (
        <YStack
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="center"
          justifyContent="center"
          zIndex={2}
          pointerEvents="none"
        >
          <YStack
            width={80}
            height={80}
            borderRadius={40}
            backgroundColor="rgba(20, 20, 22, 0.6)"
            alignItems="center"
            justifyContent="center"
          >
            {hasEnded ? (
              <RotateCcw size={40} color={bondfireColors.whiteSmoke} />
            ) : (
              <Play size={40} color={bondfireColors.whiteSmoke} fill={bondfireColors.whiteSmoke} />
            )}
          </YStack>
        </YStack>
      )}

      {/* Bottom gradient */}
      <LinearGradient
        colors={['transparent', 'rgba(20, 20, 22, 0.6)', 'rgba(20, 20, 22, 0.9)']}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 180,
          zIndex: 2,
        }}
        pointerEvents="none"
      />

      {isLive ? (
        <YStack position="absolute" bottom={104} left={20} zIndex={3}>
          <YStack
            backgroundColor={bondfireColors.error}
            paddingHorizontal={14}
            paddingVertical={7}
            borderRadius={16}
          >
            <Text color={bondfireColors.whiteSmoke} fontSize={12} fontWeight="900">
              LIVE
            </Text>
          </YStack>
        </YStack>
      ) : (
        <YStack position="absolute" bottom={100} left={20} right={20} zIndex={3}>
          <View
            ref={progressBarViewRef}
            onLayout={handleProgressBarLayout}
            {...progressBarPanResponder.panHandlers}
          >
            <YStack paddingVertical={10}>
              <YStack height={4} backgroundColor="rgba(255,255,255,0.3)" borderRadius={2}>
                <YStack
                  height={4}
                  backgroundColor={bondfireColors.bondfireCopper}
                  borderRadius={2}
                  width={`${progress * 100}%`}
                />
                <YStack
                  position="absolute"
                  top={-4}
                  left={`${progress * 100}%`}
                  marginLeft={-6}
                  width={12}
                  height={12}
                  borderRadius={6}
                  backgroundColor={bondfireColors.bondfireCopper}
                />
              </YStack>
            </YStack>
          </View>
          <XStack justifyContent="space-between" marginTop={4}>
            <Text fontSize={12} color={bondfireColors.ash}>
              {formatTime(progress * duration)}
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              {formatTime(duration)}
            </Text>
          </XStack>
        </YStack>
      )}

      {/* Creator info */}
      <YStack position="absolute" bottom={148} left={20} zIndex={3} pointerEvents="box-none">
        <XStack alignItems="center" gap={12}>
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor={isMainVideo ? bondfireColors.bondfireCopper : bondfireColors.moltenGold}
          >
            <Flame
              size={20}
              color={isMainVideo ? bondfireColors.bondfireCopper : bondfireColors.moltenGold}
            />
          </YStack>
          <YStack>
            <Text fontWeight="600" fontSize={15}>
              {creatorName}
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              {isMainVideo ? 'Spark' : `Response ${responseIndex}`}
            </Text>
          </YStack>
        </XStack>
      </YStack>

      {/* Right side controls */}
      <YStack position="absolute" right={16} bottom={160} gap={16} alignItems="center" zIndex={3}>
        {/* Report button - only show when paused */}
        {!isPlaying && !isLoading && <ReportButton onPress={() => state$.showReport.set(true)} />}
        <Pressable onPress={toggleMute}>
          <YStack
            width={44}
            height={44}
            borderRadius={22}
            backgroundColor="rgba(31, 32, 35, 0.8)"
            alignItems="center"
            justifyContent="center"
          >
            {isMuted ? (
              <VolumeX size={22} color={bondfireColors.whiteSmoke} />
            ) : (
              <Volume2 size={22} color={bondfireColors.whiteSmoke} />
            )}
          </YStack>
        </Pressable>
      </YStack>

      {/* Report Overlay */}
      {showReport && (
        <ReportOverlay
          bondfireId={bondfireId}
          bondfireVideoId={bondfireVideoId}
          videoOwnerId={videoOwnerId}
          onClose={() => state$.showReport.set(false)}
        />
      )}
    </YStack>
  )
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function BondfireDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const navigation = useNavigation()
  const flatListRef = useRef<FlatList>(null)
  const isFocused = useIsFocused()

  const screenState$ = useObservable({
    currentVideoIndex: 0,
    videoUrls: [] as (string | null)[],
    videoUrlsSd: [] as (string | null)[],
    showSettings: false,
    showNotepad: false,
    isAppActive: AppState.currentState === 'active',
  })

  const currentVideoIndex = useValue(screenState$.currentVideoIndex)
  const videoUrls = useValue(screenState$.videoUrls)
  const videoUrlsSd = useValue(screenState$.videoUrlsSd)
  const showSettings = useValue(screenState$.showSettings)
  const showNotepad = useValue(screenState$.showNotepad)
  const isAppActive = useValue(screenState$.isAppActive)
  const currentUserId = useValue(appStore$.userId)

  const bondfireId = id as Id<'bondfires'>
  const bondfireData = useQuery(api.bondfires.getWithVideos, { bondfireId }) as
    | BondfireDetailData
    | null
    | undefined
  const accessCheck = useQuery(api.bondfireInvites.canAccessBondfire, { bondfireId })
  const getVideoUrls = useAction(api.videos.getVideoUrls)
  const campContext = useQuery(api.bondfires.getWithCampContext, { id: bondfireId })
  const recordWatchEvent = useMutation(api.watchEvents.record)
  const incrementViews = useMutation(api.bondfires.incrementViews)
  const markThreadRead = useMutation(api.conversations.markThreadRead)
  const joinCamp = useMutation(api.camps.join)
  const [showJoinPrompt, setShowJoinPrompt] = useState(false)
  const [joinLoading, setJoinLoading] = useState(false)
  const [isInviteSheetOpen, setIsInviteSheetOpen] = useState(false)

  // Auto-show camp join prompt for invited users who aren't members
  useEffect(() => {
    if (accessCheck?.needsCampJoin) {
      setShowJoinPrompt(true)
    }
  }, [accessCheck])

  const didRestorePositionRef = useRef(false)
  const persistPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track app active state (external subscription - keep useEffect)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (appState) => {
      screenState$.isAppActive.set(appState === 'active')
    })

    return () => {
      subscription.remove()
    }
  }, [screenState$])

  // Load video URLs when data is available
  useEffect(() => {
    if (!bondfireData) return

    const loadUrls = async () => {
      const mainPlaybackId =
        bondfireData.videoStatus === 'live'
          ? bondfireData.muxLivePlaybackId
          : bondfireData.muxPlaybackId
      if (!mainPlaybackId) {
        telemetry.warn('video:urls:missing_playback_id', 'No playback ID for bondfire', {
          bondfireId: bondfireData._id,
          videoStatus: bondfireData.videoStatus,
        })
        return
      }

      try {
        const mainUrl = await getVideoUrls({
          muxPlaybackId: mainPlaybackId,
          muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
          bondfireId: bondfireData._id,
        })

        const playableResponses = bondfireData.videos.filter((v: Doc<'bondfireVideos'>) =>
          v.videoStatus === 'live' ? !!v.muxLivePlaybackId : !!v.muxPlaybackId,
        )
        const responseUrls: Array<{ hdUrl: string; sdUrl: string | null }> = await Promise.all(
          playableResponses.map((v) =>
            getVideoUrls({
              muxPlaybackId:
                v.videoStatus === 'live'
                  ? (v.muxLivePlaybackId as string)
                  : (v.muxPlaybackId as string),
              muxPlaybackPolicy: v.muxPlaybackPolicy,
              bondfireVideoId: v._id,
            }),
          ),
        )

        screenState$.videoUrls.set([mainUrl.hdUrl, ...responseUrls.map((r) => r.hdUrl)])
        screenState$.videoUrlsSd.set([mainUrl.sdUrl, ...responseUrls.map((r) => r.sdUrl)])

        telemetry.info('video:urls:resolved', 'Video URLs resolved', {
          bondfireId: bondfireData._id,
          mainHasToken: mainUrl.hdUrl.includes('token='),
          responseCount: responseUrls.length,
          totalVideos: 1 + responseUrls.length,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        telemetry.error('video:urls:failed', message, {
          bondfireId: bondfireData._id,
          muxPlaybackId: mainPlaybackId,
          muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
        })
      }
    }

    loadUrls()
  }, [bondfireData, getVideoUrls, screenState$])

  // Track view count - only once per day per bondfire
  useEffect(() => {
    if (!bondfireId) return
    if (!bondfireData) return
    if (bondfireData?.videoStatus === 'live') return
    if (bondfireData.userId === currentUserId) return
    if (hasViewedToday(bondfireId)) return

    let isCancelled = false

    const recordView = async () => {
      try {
        await incrementViews({ bondfireId })
        if (!isCancelled) {
          markViewed(bondfireId)
        }
      } catch (error) {
        telemetry.error('bondfire:view', 'Failed to record bondfire view', { error: String(error) })
      }
    }

    recordView()

    return () => {
      isCancelled = true
    }
  }, [bondfireId, bondfireData, currentUserId, incrementViews])

  useEffect(() => {
    if (!bondfireId || !bondfireData || !currentUserId) return
    const isParticipant = (bondfireData.participants ?? []).some(
      (participant) => participant.user._id === currentUserId,
    )
    if (!isParticipant) return

    markThreadRead({ bondfireId }).catch((error) => {
      telemetry.error('bondfire:thread', 'Failed to mark Bondfire thread read', {
        error: String(error),
      })
    })
  }, [bondfireData, bondfireId, currentUserId, markThreadRead])

  // Restore last position within this conversation (camp) once data is available.
  useEffect(() => {
    if (!bondfireData) return
    if (didRestorePositionRef.current) return
    didRestorePositionRef.current = true

    setFeedActiveBondfireId(bondfireId)

    const total = 1 + bondfireData.videos.length
    const saved = getBondfireVideoIndex(bondfireId) ?? 0
    const clamped = Math.max(0, Math.min(saved, total - 1))

    if (clamped === 0) return
    screenState$.currentVideoIndex.set(clamped)
    setTimeout(() => {
      flatListRef.current?.scrollToIndex({ index: clamped, animated: false })
    }, 0)
  }, [bondfireData, bondfireId, screenState$])

  // Persist position as the user swipes through the conversation.
  useEffect(() => {
    if (!bondfireId) return
    const indexToPersist = currentVideoIndex

    if (persistPositionTimerRef.current) {
      clearTimeout(persistPositionTimerRef.current)
    }
    persistPositionTimerRef.current = setTimeout(() => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, indexToPersist)
    }, 200)

    return () => {
      if (persistPositionTimerRef.current) {
        clearTimeout(persistPositionTimerRef.current)
        persistPositionTimerRef.current = null
      }
    }
  }, [bondfireId, currentVideoIndex])

  const handleBackPress = useCallback(() => {
    // If opened from a deep link / notification, there may not be a back stack.
    if (navigation.canGoBack()) {
      router.back()
    } else {
      router.replace(routes.feed)
    }
  }, [navigation, router])

  const handleVideoComplete = useCallback(() => {
    if (!bondfireData) return

    recordWatchEvent({
      videoType: currentVideoIndex === 0 ? 'bondfire' : 'response',
      videoId:
        currentVideoIndex === 0 ? bondfireData._id : bondfireData.videos[currentVideoIndex - 1]._id,
      eventType: 'complete',
      positionMs: 0,
    })

    // Auto-advance to next video
    if (currentVideoIndex < videoUrls.length - 1) {
      flatListRef.current?.scrollToIndex({
        index: currentVideoIndex + 1,
        animated: true,
      })
    }
  }, [bondfireData, currentVideoIndex, videoUrls.length, recordWatchEvent])

  const handleProgress = useCallback(
    (progress: number) => {
      if (!bondfireData) return

      const videoId =
        currentVideoIndex === 0 ? bondfireData._id : bondfireData.videos[currentVideoIndex - 1]._id
      const videoType = currentVideoIndex === 0 ? 'bondfire' : 'response'

      const milestones = [0.25, 0.5, 0.75] as const
      for (const milestone of milestones) {
        if (progress >= milestone && progress < milestone + 0.05) {
          const eventType = `milestone_${Math.round(milestone * 100)}` as
            | 'milestone_25'
            | 'milestone_50'
            | 'milestone_75'
          recordWatchEvent({
            videoType,
            videoId,
            eventType,
            positionMs: Math.round(progress * 1000),
          })
        }
      }
    },
    [bondfireData, currentVideoIndex, recordWatchEvent],
  )

  const handleRespond = useCallback(() => {
    if (bondfireData?.campStatus === 'archived') return
    router.push(routes.createRespondTo(id))
  }, [bondfireData?.campStatus, router, id])

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        screenState$.currentVideoIndex.set(viewableItems[0].index)
      }
    },
    [screenState$],
  )

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current

  if (!bondfireData) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
      >
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
      </YStack>
    )
  }

  const totalVideos = 1 + bondfireData.videos.length

  // Build video items with metadata - using typed IDs for type safety
  const videoItems = [
    {
      key: bondfireData._id,
      bondfireId: bondfireData._id as Id<'bondfires'>,
      bondfireVideoId: undefined as Id<'bondfireVideos'> | undefined,
      url: videoUrls[0] ?? null,
      urlSd: videoUrlsSd[0] ?? null,
      videoOwnerId: bondfireData.userId,
      creatorName: bondfireData.creatorName ?? 'Anonymous',
      isMainVideo: true,
      responseIndex: undefined as number | undefined,
      isLive: bondfireData.videoStatus === 'live',
    },
    ...bondfireData.videos.map((v: Doc<'bondfireVideos'>, i: number) => ({
      key: v._id,
      bondfireId: undefined as Id<'bondfires'> | undefined,
      bondfireVideoId: v._id as Id<'bondfireVideos'>,
      url: videoUrls[i + 1] ?? null,
      urlSd: videoUrlsSd[i + 1] ?? null,
      videoOwnerId: v.userId,
      creatorName: v.creatorName ?? 'Anonymous',
      isMainVideo: false,
      responseIndex: i + 1,
      isLive: v.videoStatus === 'live',
    })),
  ]

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        {/* Header */}
        <XStack
          position="absolute"
          top={0}
          left={0}
          right={0}
          zIndex={100}
          paddingTop={50}
          paddingHorizontal={16}
          paddingBottom={12}
        >
          <LinearGradient
            colors={['rgba(20, 20, 22, 0.9)', 'rgba(20, 20, 22, 0.5)', 'transparent']}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 100,
            }}
          />
          <XStack flex={1} justifyContent="space-between" alignItems="center">
            <Pressable onPress={handleBackPress}>
              <XStack
                paddingHorizontal={12}
                height={40}
                borderRadius={20}
                backgroundColor="rgba(31, 32, 35, 0.8)"
                alignItems="center"
                gap={6}
              >
                <ChevronLeft size={22} color={bondfireColors.whiteSmoke} />
                <Text fontSize={13} fontWeight="700" color={bondfireColors.whiteSmoke}>
                  Campground
                </Text>
              </XStack>
            </Pressable>

            <YStack alignItems="center">
              <Text fontWeight="600" fontSize={16}>
                {currentVideoIndex + 1} / {totalVideos}
              </Text>
              <Text fontSize={12} color={bondfireColors.ash}>
                Swipe for responses
              </Text>
            </YStack>

            <XStack gap={8}>
              <Pressable
                onPress={() => screenState$.showSettings.set(!screenState$.showSettings.get())}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={
                    showSettings ? bondfireColors.bondfireCopper : 'rgba(31, 32, 35, 0.8)'
                  }
                  alignItems="center"
                  justifyContent="center"
                >
                  <Settings size={22} color={bondfireColors.whiteSmoke} />
                </YStack>
              </Pressable>
              <Pressable
                onPress={() => screenState$.showNotepad.set(!screenState$.showNotepad.get())}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={
                    showNotepad ? bondfireColors.bondfireCopper : 'rgba(31, 32, 35, 0.8)'
                  }
                  alignItems="center"
                  justifyContent="center"
                >
                  <FileText size={22} color={bondfireColors.whiteSmoke} />
                </YStack>
              </Pressable>
            </XStack>
          </XStack>
        </XStack>

        {/* Horizontal swipe video carousel */}
        <FlatList
          ref={flatListRef}
          data={videoItems}
          keyExtractor={(item) => item.key}
          renderItem={({ item, index }) => (
            <VideoPlayer
              bondfireId={item.bondfireId}
              bondfireVideoId={item.bondfireVideoId}
              videoUrl={item.url}
              videoUrlSd={item.urlSd}
              videoOwnerId={item.videoOwnerId}
              isActive={index === currentVideoIndex}
              isScreenFocused={isFocused}
              isAppActive={isAppActive}
              onComplete={handleVideoComplete}
              onProgress={handleProgress}
              creatorName={item.creatorName}
              isMainVideo={item.isMainVideo}
              responseIndex={item.responseIndex}
              isLive={item.isLive}
            />
          )}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          snapToInterval={SCREEN_WIDTH}
          snapToAlignment="start"
          decelerationRate="fast"
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          getItemLayout={(_, index) => ({
            length: SCREEN_WIDTH,
            offset: SCREEN_WIDTH * index,
            index,
          })}
        />

        {/* Navigation hints */}
        {currentVideoIndex < totalVideos - 1 && (
          <YStack
            position="absolute"
            right={8}
            top="50%"
            marginTop={-20}
            opacity={0.6}
            pointerEvents="none"
          >
            <ChevronRight size={32} color={bondfireColors.whiteSmoke} />
          </YStack>
        )}

        {bondfireData.campStatus !== 'archived' ? (
          <YStack
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            paddingHorizontal={20}
            paddingBottom={28}
            paddingTop={16}
          >
            <LinearGradient
              colors={['transparent', 'rgba(20, 20, 22, 0.9)']}
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 120,
              }}
            />
            {campContext?.canInvite ? (
              <XStack gap={12}>
                <Button
                  variant="outline"
                  size="$lg"
                  flex={1}
                  onPress={() => setIsInviteSheetOpen(true)}
                >
                  <Text color={bondfireColors.whiteSmoke} fontWeight="700">
                    Share Bondfire
                  </Text>
                </Button>
                <Button variant="primary" size="$lg" flex={1} onPress={handleRespond}>
                  <Flame size={18} color={bondfireColors.whiteSmoke} />
                  <Text color={bondfireColors.whiteSmoke} fontWeight="700">
                    Respond
                  </Text>
                </Button>
              </XStack>
            ) : (
              <Button variant="primary" size="$lg" onPress={handleRespond}>
                <Flame size={20} color={bondfireColors.whiteSmoke} />
                <Text color={bondfireColors.whiteSmoke}>Add Your Response</Text>
              </Button>
            )}
          </YStack>
        ) : null}

        {/* Video position dots */}
        <XStack position="absolute" bottom={100} left={0} right={0} justifyContent="center" gap={8}>
          {videoItems.map((item, i) => (
            <Pressable
              key={item.key}
              onPress={() => {
                flatListRef.current?.scrollToIndex({ index: i, animated: true })
              }}
            >
              <YStack
                width={i === currentVideoIndex ? 24 : 8}
                height={8}
                borderRadius={4}
                backgroundColor={
                  i === currentVideoIndex ? bondfireColors.bondfireCopper : 'rgba(255,255,255,0.4)'
                }
              />
            </Pressable>
          ))}
        </XStack>

        {/* Settings Popover */}
        {showSettings && <SettingsPopover onClose={() => screenState$.showSettings.set(false)} />}

        {/* Notepad Overlay */}
        {showNotepad && <NotepadOverlay onClose={() => screenState$.showNotepad.set(false)} />}

        {/* Camp Join Prompt — shown for invited users who aren't members */}
        {showJoinPrompt && accessCheck?.campId && (
          <Sheet
            open={showJoinPrompt}
            onOpenChange={(isOpen: boolean) => {
              if (!isOpen) setShowJoinPrompt(false)
            }}
            snapPoints={[50]}
            dismissOnSnapToBottom
          >
            <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
            <Sheet.Frame
              backgroundColor={bondfireColors.charcoal}
              borderTopLeftRadius={20}
              borderTopRightRadius={20}
              padding={24}
            >
              <YStack gap={20} alignItems="center">
                <Sheet.Handle backgroundColor={bondfireColors.iron} />
                <Text fontSize={22} fontWeight="900" textAlign="center">
                  Join Camp to View
                </Text>
                <Text fontSize={14} color={bondfireColors.ash} textAlign="center" lineHeight={20}>
                  This bondfire is in a camp you haven't joined yet. Join to watch and respond.
                </Text>
                <Button
                  variant="primary"
                  size="$lg"
                  width="100%"
                  onPress={async () => {
                    if (!accessCheck.campId) return
                    setJoinLoading(true)
                    try {
                      await joinCamp({ campId: accessCheck.campId })
                      setShowJoinPrompt(false)
                    } catch (error) {
                      Alert.alert(
                        'Could not join',
                        error instanceof Error ? error.message : String(error),
                      )
                    } finally {
                      setJoinLoading(false)
                    }
                  }}
                  disabled={joinLoading}
                >
                  <Text color={bondfireColors.whiteSmoke} fontWeight="700">
                    {joinLoading ? 'Joining...' : 'Join Camp'}
                  </Text>
                </Button>
              </YStack>
            </Sheet.Frame>
          </Sheet>
        )}

        {/* Invite Sheet */}
        <InviteSheet
          bondfireId={bondfireId}
          open={isInviteSheetOpen}
          onClose={() => setIsInviteSheetOpen(false)}
        />
      </YStack>
    </>
  )
}
