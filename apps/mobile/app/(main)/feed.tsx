import { appActions, appStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useObserveEffect, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Eye, Flame, MessageCircle, Play, Volume2, VolumeX } from '@tamagui/lucide-icons'
import { useAction, useQuery } from 'convex/react'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useCallback, useEffect, useRef } from 'react'
import { AppState, Dimensions, FlatList, Pressable, StatusBar, type ViewToken } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')
// Account for status bar and tab bar
const ITEM_HEIGHT = SCREEN_HEIGHT

interface BondfireData {
  _id: string
  creatorName?: string
  videoKey: string
  sdVideoKey?: string
  thumbnailKey?: string
  videoCount: number
  viewCount?: number
  thumbnailUrl?: string
  createdAt: number
}

interface BondfireItemProps {
  bondfire: BondfireData
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  videoUrl: string | null
  videoUrlSd: string | null
  onPress: () => void
  onRespond: () => void
}

function BondfireItem({
  bondfire,
  isActive,
  isScreenFocused,
  isAppActive,
  videoUrl,
  videoUrlSd,
  onPress,
  onRespond,
}: BondfireItemProps) {
  const timeAgo = getTimeAgo(bondfire.createdAt)
  const autoplayVideos = useValue(appStore$.preferences.autoplayVideos)
  const videoQuality = useValue(appStore$.preferences.videoQuality)
  const isMuted = useValue(appStore$.preferences.videoMuted)

  const state$ = useObservable({
    isLoading: true,
    userInitiatedPlay: false,
  })

  // Play icon fade animation
  const playIconOpacity = useSharedValue(1)
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Determine which URL to use based on quality preference
  const currentUrl = videoQuality === 'sd' && videoUrlSd ? videoUrlSd : videoUrl

  const player = useVideoPlayer(currentUrl || '', (player) => {
    player.loop = true
    player.muted = isMuted
    player.preservesPitch = true
  })

  // Update mute state when preference changes (effect phase for player mutations)
  useObserveEffect(() => {
    if (player) {
      player.muted = appStore$.preferences.videoMuted.get()
    }
  })

  // Play/pause based on isActive, screen focus, app state, and autoplay preference
  useEffect(() => {
    if (!player) return

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

  // Monitor playback status (external subscription - keep useEffect)
  useEffect(() => {
    if (!player) return

    const subscription = player.addListener('statusChange', (status) => {
      if (status.status === 'readyToPlay') {
        state$.isLoading.set(false)
      } else if (status.status === 'loading') {
        state$.isLoading.set(true)
      }
    })

    return () => {
      subscription.remove()
    }
  }, [player, state$])

  const togglePlayPause = useCallback(() => {
    if (!player) return

    if (player.playing) {
      player.pause()
    } else {
      // User manually initiated play
      state$.userInitiatedPlay.set(true)
      player.play()
    }
  }, [player, state$])

  const toggleMute = useCallback(() => {
    appActions.setVideoMuted(!appStore$.preferences.videoMuted.get())
  }, [])

  const isPlaying = player?.playing ?? false
  const hasVideo = !!currentUrl
  const isLoading = useValue(state$.isLoading)

  // Animate play icon fade based on playing state
  useEffect(() => {
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current)
      fadeTimeoutRef.current = null
    }

    if (isPlaying) {
      // Video started playing - fade out after 2.5 seconds
      fadeTimeoutRef.current = setTimeout(() => {
        playIconOpacity.value = withTiming(0, { duration: 300 })
      }, 2500)
    } else {
      // Video paused - show play icon immediately
      playIconOpacity.value = withTiming(1, { duration: 200 })
    }

    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current)
      }
    }
  }, [isPlaying, playIconOpacity])

  const playIconAnimatedStyle = useAnimatedStyle(() => ({
    opacity: playIconOpacity.value,
  }))

  return (
    <Pressable
      onPress={hasVideo ? togglePlayPause : onPress}
      style={{ width: SCREEN_WIDTH, height: ITEM_HEIGHT }}
    >
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        {/* Video/Thumbnail area */}
        <YStack flex={1} alignItems="center" justifyContent="center">
          {hasVideo && player ? (
            <VideoView
              player={player}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              nativeControls={false}
            />
          ) : bondfire.thumbnailUrl ? (
            <Image
              source={{ uri: bondfire.thumbnailUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
            />
          ) : (
            <YStack flex={1} alignItems="center" justifyContent="center" width="100%">
              <Flame size={120} color={bondfireColors.bondfireCopper} />
            </YStack>
          )}
        </YStack>

        {/* Loading overlay */}
        {hasVideo && isLoading && (
          <YStack
            position="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            alignItems="center"
            justifyContent="center"
            backgroundColor="rgba(20, 20, 22, 0.5)"
          >
            <Spinner size="large" color={bondfireColors.bondfireCopper} />
          </YStack>
        )}

        {/* Play/Pause indicator with fade animation */}
        {hasVideo && !isLoading && (
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              },
              playIconAnimatedStyle,
            ]}
          >
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              backgroundColor="rgba(20, 20, 22, 0.6)"
              alignItems="center"
              justifyContent="center"
            >
              <Play size={40} color={bondfireColors.whiteSmoke} fill={bondfireColors.whiteSmoke} />
            </YStack>
          </Animated.View>
        )}

        {/* Bottom gradient overlay */}
        <LinearGradient
          colors={['transparent', 'rgba(20, 20, 22, 0.8)', bondfireColors.obsidian]}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 250,
          }}
        />

        {/* Bottom info section */}
        <YStack position="absolute" bottom={100} left={0} right={0} paddingHorizontal={20} gap={12}>
          {/* Creator info */}
          <XStack alignItems="center" gap={12}>
            <YStack
              width={48}
              height={48}
              borderRadius={24}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.bondfireCopper}
            >
              <Text fontSize={20}>🔥</Text>
            </YStack>
            <YStack>
              <Text fontWeight="700" fontSize={16}>
                {bondfire.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={13} color={bondfireColors.ash}>
                {timeAgo}
              </Text>
            </YStack>
          </XStack>

          {/* Stats row */}
          <XStack gap={20}>
            <XStack alignItems="center" gap={6}>
              <Eye size={18} color={bondfireColors.ash} />
              <Text fontSize={14} color={bondfireColors.ash}>
                {bondfire.viewCount ?? 0}
              </Text>
            </XStack>
            <XStack alignItems="center" gap={6}>
              <MessageCircle size={18} color={bondfireColors.ash} />
              <Text fontSize={14} color={bondfireColors.ash}>
                {bondfire.videoCount} {bondfire.videoCount === 1 ? 'response' : 'responses'}
              </Text>
            </XStack>
          </XStack>
        </YStack>

        {/* Right side action buttons */}
        <YStack position="absolute" right={16} bottom={100} gap={20} alignItems="center">
          {/* View details / respond button */}
          <Pressable onPress={onPress}>
            <YStack alignItems="center" gap={4}>
              <YStack
                width={48}
                height={48}
                borderRadius={24}
                backgroundColor={bondfireColors.bondfireCopper}
                alignItems="center"
                justifyContent="center"
              >
                <Flame size={24} color={bondfireColors.whiteSmoke} />
              </YStack>
              <Text fontSize={12} color={bondfireColors.whiteSmoke}>
                View
              </Text>
            </YStack>
          </Pressable>

          <Pressable onPress={onRespond}>
            <YStack alignItems="center" gap={4}>
              <YStack
                width={48}
                height={48}
                borderRadius={24}
                backgroundColor={bondfireColors.gunmetal}
                alignItems="center"
                justifyContent="center"
                borderWidth={2}
                borderColor={bondfireColors.bondfireCopper}
              >
                <MessageCircle size={24} color={bondfireColors.bondfireCopper} />
              </YStack>
              <Text fontSize={12} color={bondfireColors.whiteSmoke}>
                Respond
              </Text>
            </YStack>
          </Pressable>

          {/* Mute/Unmute button */}
          {hasVideo && (
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
          )}
        </YStack>
      </YStack>
    </Pressable>
  )
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

function EmptyFeed() {
  const router = useRouter()

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
      paddingHorizontal={40}
    >
      <YStack
        width={120}
        height={120}
        borderRadius={60}
        backgroundColor={bondfireColors.gunmetal}
        alignItems="center"
        justifyContent="center"
        marginBottom={32}
      >
        <Flame size={60} color={bondfireColors.bondfireCopper} />
      </YStack>
      <Text fontSize={24} fontWeight="700" marginBottom={12} textAlign="center">
        Spark a Bondfire
      </Text>
      <Text fontSize={16} color={bondfireColors.ash} textAlign="center" marginBottom={32}>
        Be the first to share a video!
      </Text>
      <Button variant="primary" size="$lg" onPress={() => router.push('/(main)/create')}>
        <Flame size={20} color={bondfireColors.whiteSmoke} />
        <Text color={bondfireColors.whiteSmoke}>Spark Bondfire</Text>
      </Button>
    </YStack>
  )
}

function LoadingFeed() {
  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
    >
      <Spinner size="large" color={bondfireColors.bondfireCopper} />
      <Text marginTop={20} color={bondfireColors.ash}>
        Loading bondfires...
      </Text>
    </YStack>
  )
}

export default function FeedScreen() {
  const router = useRouter()
  const isFocused = useIsFocused()
  const bondfires = useQuery(api.bondfires.listFeed, { limit: 20 })
  const getVideoUrls = useAction(api.videos.getVideoUrls)

  const feedState$ = useObservable({
    activeIndex: 0,
    videoUrls: {} as Record<string, { hdUrl: string | null; sdUrl: string | null }>,
    isAppActive: AppState.currentState === 'active',
  })
  const flatListRef = useRef<FlatList>(null)
  const loadingUrlsRef = useRef<Set<string>>(new Set())

  const activeIndex = useValue(feedState$.activeIndex)
  const videoUrls = useValue(feedState$.videoUrls)
  const isAppActive = useValue(feedState$.isAppActive)

  // Track app active state (external subscription - keep useEffect)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      feedState$.isAppActive.set(state === 'active')
    })

    return () => {
      subscription.remove()
    }
  }, [feedState$])

  // Load video URLs for bondfires near the active index (preload adjacent videos)
  useEffect(() => {
    if (!bondfires) return

    const loadVideoUrls = async () => {
      const currentActiveIndex = feedState$.activeIndex.get()
      // Load URLs for current, previous, and next items
      const indicesToLoad = [currentActiveIndex - 1, currentActiveIndex, currentActiveIndex + 1].filter(
        (i) => i >= 0 && i < bondfires.length,
      )

      for (const index of indicesToLoad) {
        const bondfire = bondfires[index]
        // Skip if we're already loading or have loaded this URL
        if (loadingUrlsRef.current.has(bondfire._id)) continue
        loadingUrlsRef.current.add(bondfire._id)

        try {
          const urls = await getVideoUrls({
            hdKey: bondfire.videoKey,
            sdKey: bondfire.sdVideoKey,
          })

          feedState$.videoUrls[bondfire._id].set({ hdUrl: urls.hdUrl, sdUrl: urls.sdUrl })
        } catch (error) {
          console.error('Failed to load video URL for bondfire:', bondfire._id, error)
          // Remove from loading set on error so we can retry
          loadingUrlsRef.current.delete(bondfire._id)
        }
      }
    }

    loadVideoUrls()
  }, [bondfires, activeIndex, getVideoUrls, feedState$])

  const handleBondfirePress = useCallback(
    (bondfireId: string) => {
      // Unmute when navigating to detail view
      appActions.setVideoMuted(false)
      router.push(`/(main)/bondfire/${bondfireId}`)
    },
    [router],
  )

  const handleRespond = useCallback(
    (bondfireId: string) => {
      router.push(`/(main)/create?respondTo=${bondfireId}`)
    },
    [router],
  )

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        feedState$.activeIndex.set(viewableItems[0].index)
      }
    },
    [feedState$],
  )

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current

  if (bondfires === undefined) {
    return <LoadingFeed />
  }

  if (bondfires.length === 0) {
    return <EmptyFeed />
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      <FlatList
        ref={flatListRef}
        data={bondfires}
        keyExtractor={(item) => item._id}
        renderItem={({ item, index }) => (
          <BondfireItem
            bondfire={item}
            isActive={index === activeIndex}
            isScreenFocused={isFocused}
            isAppActive={isAppActive}
            videoUrl={videoUrls[item._id]?.hdUrl ?? null}
            videoUrlSd={videoUrls[item._id]?.sdUrl ?? null}
            onPress={() => handleBondfirePress(item._id)}
            onRespond={() => handleRespond(item._id)}
          />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        getItemLayout={(_, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * index,
          index,
        })}
      />
    </YStack>
  )
}
