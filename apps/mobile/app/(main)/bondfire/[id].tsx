import { Button, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { ChevronLeft, Play, Volume2, VolumeX, Flame, Settings, ChevronRight } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { type AVPlaybackStatus, ResizeMode, Video } from 'expo-av'
import { LinearGradient } from 'expo-linear-gradient'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dimensions, FlatList, Pressable, StatusBar, type ViewToken } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'

const { width: SCREEN_WIDTH } = Dimensions.get('window')

interface VideoPlayerProps {
  videoUrl: string | null
  isActive: boolean
  onComplete: () => void
  onProgress: (progress: number) => void
  creatorName: string
  isMainVideo: boolean
  responseIndex?: number
}

function VideoPlayer({
  videoUrl,
  isActive,
  onComplete,
  onProgress,
  creatorName,
  isMainVideo,
  responseIndex,
}: VideoPlayerProps) {
  const videoRef = useRef<Video>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (isActive && videoRef.current) {
      videoRef.current.playAsync()
    } else if (!isActive && videoRef.current) {
      videoRef.current.pauseAsync()
    }
  }, [isActive])

  const handlePlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) {
        setIsLoading(true)
        return
      }

      setIsLoading(false)
      setIsPlaying(status.isPlaying)

      if (status.durationMillis) {
        setDuration(status.durationMillis)
        const currentProgress = status.positionMillis / status.durationMillis
        setProgress(currentProgress)
        onProgress(currentProgress)

        if (status.didJustFinish) {
          onComplete()
        }
      }
    },
    [onComplete, onProgress],
  )

  const togglePlayPause = useCallback(async () => {
    if (!videoRef.current) return

    if (isPlaying) {
      await videoRef.current.pauseAsync()
    } else {
      await videoRef.current.playAsync()
    }
  }, [isPlaying])

  const toggleMute = useCallback(async () => {
    if (!videoRef.current) return
    await videoRef.current.setIsMutedAsync(!isMuted)
    setIsMuted(!isMuted)
  }, [isMuted])

  return (
    <Pressable style={{ flex: 1, width: SCREEN_WIDTH }} onPress={togglePlayPause}>
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        {videoUrl ? (
          <Video
            ref={videoRef}
            source={{ uri: videoUrl }}
            style={{ flex: 1 }}
            resizeMode={ResizeMode.COVER}
            shouldPlay={isActive}
            isMuted={isMuted}
            isLooping={false}
            onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
          />
        ) : (
          <YStack flex={1} alignItems="center" justifyContent="center">
            <Spinner size="large" color={bondfireColors.bondfireCopper} />
          </YStack>
        )}

        {/* Loading overlay */}
        {isLoading && videoUrl && (
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

        {/* Play/Pause indicator */}
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
              <Play size={40} color={bondfireColors.whiteSmoke} fill={bondfireColors.whiteSmoke} />
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

        {/* Progress bar */}
        <YStack
          position="absolute"
          bottom={100}
          left={20}
          right={20}
        >
          <YStack height={3} backgroundColor="rgba(255,255,255,0.3)" borderRadius={2}>
            <YStack
              height={3}
              backgroundColor={bondfireColors.bondfireCopper}
              borderRadius={2}
              width={`${progress * 100}%`}
            />
          </YStack>
          <XStack justifyContent="space-between" marginTop={8}>
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
              <Flame size={20} color={isMainVideo ? bondfireColors.bondfireCopper : bondfireColors.moltenGold} />
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

  const [currentVideoIndex, setCurrentVideoIndex] = useState(0)
  const [videoUrls, setVideoUrls] = useState<(string | null)[]>([])

  const bondfireId = id as Id<'bondfires'>
  const bondfireData = useQuery(api.bondfires.getWithVideos, { bondfireId })
  const getVideoUrls = useAction(api.videos.getVideoUrls)
  const recordWatchEvent = useMutation(api.watchEvents.record)
  const incrementViews = useMutation(api.bondfires.incrementViews)

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

      setVideoUrls([mainUrl.hdUrl, ...responseUrls.map((r) => r.hdUrl)])
    }

    loadUrls()
    incrementViews({ bondfireId })
  }, [bondfireData, bondfireId, getVideoUrls, incrementViews])

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
        setCurrentVideoIndex(viewableItems[0].index)
      }
    },
    [],
  )

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current

  if (!bondfireData) {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian} alignItems="center" justifyContent="center">
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
      </YStack>
    )
  }

  const totalVideos = 1 + bondfireData.videos.length

  // Build video items with metadata
  const videoItems = [
    {
      id: bondfireData._id,
      url: videoUrls[0] ?? null,
      creatorName: bondfireData.creatorName ?? 'Anonymous',
      isMainVideo: true,
      responseIndex: undefined,
    },
    ...bondfireData.videos.map((v, i) => ({
      id: v._id,
      url: videoUrls[i + 1] ?? null,
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

            <Pressable>
              <YStack
                width={40}
                height={40}
                borderRadius={20}
                backgroundColor="rgba(31, 32, 35, 0.8)"
                alignItems="center"
                justifyContent="center"
              >
                <Settings size={22} color={bondfireColors.whiteSmoke} />
              </YStack>
            </Pressable>
          </XStack>
        </XStack>

        {/* Horizontal swipe video carousel */}
        <FlatList
          ref={flatListRef}
          data={videoItems}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <VideoPlayer
              videoUrl={item.url}
              isActive={index === currentVideoIndex}
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
          paddingBottom={40}
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
        <XStack
          position="absolute"
          bottom={100}
          left={0}
          right={0}
          justifyContent="center"
          gap={8}
        >
          {videoItems.map((item, i) => (
            <Pressable
              key={item.id}
              onPress={() => {
                flatListRef.current?.scrollToIndex({ index: i, animated: true })
              }}
            >
              <YStack
                width={i === currentVideoIndex ? 24 : 8}
                height={8}
                borderRadius={4}
                backgroundColor={i === currentVideoIndex ? bondfireColors.bondfireCopper : 'rgba(255,255,255,0.4)'}
              />
            </Pressable>
          ))}
        </XStack>
      </YStack>
    </>
  )
}
