import { appActions, appStore$, hasViewedToday, markViewed } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useObserveEffect, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
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
import { VideoView, useVideoPlayer } from 'expo-video'
import { useCallback, useEffect, useRef } from 'react'
import {
  AppState,
  Dimensions,
  FlatList,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StatusBar,
  type ViewToken,
} from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { NotepadOverlay } from '../../../components/NotepadOverlay'
import { ReportButton } from '../../../components/ReportButton'
import { ReportOverlay } from '../../../components/ReportOverlay'
import { SettingsPopover } from '../../../components/SettingsPopover'

const { width: SCREEN_WIDTH } = Dimensions.get('window')

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
}: VideoPlayerProps) {
  // Get the video ID for internal use (keep-awake tag, etc.)
  const videoId = bondfireId || bondfireVideoId || ''
  const playbackSpeed = useValue(appStore$.preferences.playbackSpeed)
  const autoplayVideos = useValue(appStore$.preferences.autoplayVideos)
  const videoQuality = useValue(appStore$.preferences.videoQuality)
  const isMuted = useValue(appStore$.preferences.videoMuted)

  // Determine initial URL based on quality preference
  const getInitialUrl = () => {
    if (videoQuality === 'sd' && videoUrlSd) return videoUrlSd
    return videoUrl // HD or auto starts with HD
  }

  const state$ = useObservable({
    showReport: false,
    currentUrl: getInitialUrl(),
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
  const progressBarRef = useRef<{ width: number; x: number }>({ width: 0, x: 0 })

  const player = useVideoPlayer(currentUrl || '', (player) => {
    player.loop = false
    player.muted = isMuted
    player.playbackRate = playbackSpeed
    player.preservesPitch = true
  })

  // Update playback speed when preference changes (effect phase for player mutations)
  useObserveEffect(() => {
    if (player) {
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
    const shouldPlay = isActive && isScreenFocused && isAppActive

    if (shouldPlay) {
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
  }, [player, isActive, isScreenFocused, isAppActive, autoplayVideos, state$])

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
        if (player.currentTime !== undefined && player.duration) {
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
      if (player.status === 'readyToPlay' && player.currentTime !== undefined && player.duration) {
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
  }, [player, onComplete, onProgress, state$])

  // Buffering detection - switch to SD if buffer is low (only in auto mode)
  useEffect(() => {
    // Only apply adaptive quality switching in 'auto' mode
    if (videoQuality !== 'auto') return
    const hasSwitchedToSD = state$.hasSwitchedToSD.get()
    const currentUrlValue = state$.currentUrl.get()
    if (!videoUrlSd || hasSwitchedToSD || !currentUrlValue || currentUrlValue !== videoUrl) {
      return
    }

    bufferingCheckInterval.current = setInterval(() => {
      if (!player || state$.hasSwitchedToSD.get()) return

      // Check if player is buffering and we have SD available
      if (player.status === 'loading' && player.currentTime !== undefined && player.duration) {
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
  }, [player, videoUrlSd, videoUrl, videoQuality, state$])

  // Update URL when video quality preference or source URLs change
  useEffect(() => {
    let targetUrl: string | null = null

    if (videoQuality === 'sd' && videoUrlSd) {
      targetUrl = videoUrlSd
    } else if (videoQuality === 'hd' || videoQuality === 'auto') {
      targetUrl = videoUrl
    }

    const currentUrlValue = state$.currentUrl.get()
    if (targetUrl && currentUrlValue !== targetUrl) {
      state$.currentUrl.set(targetUrl)
      // Only reset hasSwitchedToSD when preference changes or new video
      if (videoQuality !== 'auto') {
        state$.hasSwitchedToSD.set(false)
      }
    }
  }, [videoUrl, videoUrlSd, videoQuality, state$])

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
    const { width, x } = event.nativeEvent.layout
    progressBarRef.current = { width, x }
  }, [])

  const handleProgressBarPress = useCallback(
    (event: GestureResponderEvent) => {
      if (!player || !player.duration) return

      const { locationX } = event.nativeEvent
      const { width } = progressBarRef.current

      if (width > 0) {
        const seekProgress = Math.max(0, Math.min(1, locationX / width))
        const seekTime = seekProgress * player.duration
        player.currentTime = seekTime
        state$.progress.set(seekProgress)
        state$.hasEnded.set(false)
        state$.userInitiatedPlay.set(true)
      }
    },
    [player, state$],
  )

  return (
    <Pressable style={{ flex: 1, width: SCREEN_WIDTH }} onPress={togglePlayPause}>
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        {currentUrl && player ? (
          <VideoView
            player={player}
            style={{ flex: 1 }}
            contentFit="cover"
            nativeControls={false}
          />
        ) : (
          <YStack flex={1} alignItems="center" justifyContent="center">
            <Spinner size="large" color={bondfireColors.bondfireCopper} />
          </YStack>
        )}

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
          }}
          pointerEvents="none"
        />

        {/* Progress bar - interactive for scrubbing */}
        <YStack position="absolute" bottom={100} left={20} right={20}>
          <Pressable onPress={handleProgressBarPress} onLayout={handleProgressBarLayout}>
            <YStack paddingVertical={10}>
              <YStack height={4} backgroundColor="rgba(255,255,255,0.3)" borderRadius={2}>
                <YStack
                  height={4}
                  backgroundColor={bondfireColors.bondfireCopper}
                  borderRadius={2}
                  width={`${progress * 100}%`}
                />
                {/* Scrubber thumb */}
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
          </Pressable>
          <XStack justifyContent="space-between" marginTop={4}>
            <Text fontSize={12} color={bondfireColors.ash}>
              {formatTime(progress * duration)}
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              {formatTime(duration)}
            </Text>
          </XStack>
        </YStack>

        {/* Creator info */}
        <YStack position="absolute" bottom={140} left={20}>
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
                {isMainVideo ? 'Original' : `Response ${responseIndex}`}
              </Text>
            </YStack>
          </XStack>
        </YStack>

        {/* Right side controls */}
        <YStack position="absolute" right={16} bottom={160} gap={16} alignItems="center">
          {/* Report button - only show when paused */}
          {!isPlaying && !isLoading && (
            <ReportButton onPress={() => state$.showReport.set(true)} />
          )}
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
    </Pressable>
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

  const bondfireId = id as Id<'bondfires'>
  const bondfireData = useQuery(api.bondfires.getWithVideos, { bondfireId })
  const getVideoUrls = useAction(api.videos.getVideoUrls)
  const recordWatchEvent = useMutation(api.watchEvents.record)
  const incrementViews = useMutation(api.bondfires.incrementViews)

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
      const mainUrl = await getVideoUrls({
        hdKey: bondfireData.videoKey,
        sdKey: bondfireData.sdVideoKey,
      })

      const responseUrls = await Promise.all(
        bondfireData.videos.map((v) => getVideoUrls({ hdKey: v.videoKey, sdKey: v.sdVideoKey })),
      )

      screenState$.videoUrls.set([mainUrl.hdUrl, ...responseUrls.map((r) => r.hdUrl)])
      screenState$.videoUrlsSd.set([mainUrl.sdUrl, ...responseUrls.map((r) => r.sdUrl)])
    }

    loadUrls()
  }, [bondfireData, getVideoUrls, screenState$])

  // Track view count - only once per day per bondfire
  useEffect(() => {
    if (!bondfireId) return
    if (hasViewedToday(bondfireId)) return

    markViewed(bondfireId)
    incrementViews({ bondfireId })
  }, [bondfireId, incrementViews])

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
    router.push(`/(main)/create?respondTo=${id}`)
  }, [router, id])

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
    },
    ...bondfireData.videos.map((v, i) => ({
      key: v._id,
      bondfireId: undefined as Id<'bondfires'> | undefined,
      bondfireVideoId: v._id as Id<'bondfireVideos'>,
      url: videoUrls[i + 1] ?? null,
      urlSd: videoUrlsSd[i + 1] ?? null,
      videoOwnerId: v.userId,
      creatorName: v.creatorName ?? 'Anonymous',
      isMainVideo: false,
      responseIndex: i + 1,
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
            <Pressable onPress={() => router.back()}>
              <YStack
                width={40}
                height={40}
                borderRadius={20}
                backgroundColor="rgba(31, 32, 35, 0.8)"
                alignItems="center"
                justifyContent="center"
              >
                <ChevronLeft size={24} color={bondfireColors.whiteSmoke} />
              </YStack>
            </Pressable>

            <YStack alignItems="center">
              <Text fontWeight="600" fontSize={16}>
                {currentVideoIndex + 1} / {totalVideos}
              </Text>
              <Text fontSize={12} color={bondfireColors.ash}>
                Swipe to navigate
              </Text>
            </YStack>

            <XStack gap={8}>
              <Pressable onPress={() => screenState$.showSettings.set(!screenState$.showSettings.get())}>
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
              <Pressable onPress={() => screenState$.showNotepad.set(!screenState$.showNotepad.get())}>
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

        {/* Bottom action bar */}
        <YStack
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          paddingHorizontal={20}
          paddingBottom={20}
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
          <Button variant="primary" size="$lg" onPress={handleRespond}>
            <Flame size={20} color={bondfireColors.whiteSmoke} />
            <Text color={bondfireColors.whiteSmoke}>Add Your Response</Text>
          </Button>
        </YStack>

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
      </YStack>
    </>
  )
}
