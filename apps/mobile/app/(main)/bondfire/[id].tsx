import { useState, useRef, useCallback, useEffect } from 'react'
import { Dimensions, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { YStack, XStack, Spinner } from 'tamagui'
import { Container, Button, Text } from '@bondfires/ui'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { Id } from '../../../../convex/_generated/dataModel'
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av'
import { ChevronLeft, Play, Pause, Volume2, VolumeX, SkipForward } from '@tamagui/lucide-icons'

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')

interface VideoPlayerProps {
  videoUrl: string | null
  isActive: boolean
  onComplete: () => void
  onProgress: (progress: number) => void
}

function VideoPlayer({ videoUrl, isActive, onComplete, onProgress }: VideoPlayerProps) {
  const videoRef = useRef<Video>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  
  useEffect(() => {
    if (isActive && videoRef.current) {
      videoRef.current.playAsync()
    } else if (!isActive && videoRef.current) {
      videoRef.current.pauseAsync()
    }
  }, [isActive])
  
  const handlePlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return
    
    setIsPlaying(status.isPlaying)
    
    if (status.durationMillis) {
      setDuration(status.durationMillis)
      const currentProgress = status.positionMillis / status.durationMillis
      setProgress(currentProgress)
      onProgress(currentProgress)
      
      // Check for completion
      if (status.didJustFinish) {
        onComplete()
      }
    }
  }, [onComplete, onProgress])
  
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
  
  if (!videoUrl) {
    return (
      <YStack
        flex={1}
        backgroundColor="$gray2"
        alignItems="center"
        justifyContent="center"
      >
        <Spinner size="large" color="$orange10" />
        <Text marginTop="$2" color="$gray11">Loading video...</Text>
      </YStack>
    )
  }
  
  return (
    <Pressable
      style={{ flex: 1 }}
      onPress={() => setShowControls(!showControls)}
    >
      <Video
        ref={videoRef}
        source={{ uri: videoUrl }}
        style={{ flex: 1 }}
        resizeMode={ResizeMode.COVER}
        shouldPlay={isActive}
        isLooping={false}
        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
      />
      
      {/* Video controls overlay */}
      {showControls && (
        <YStack
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          padding="$4"
          backgroundColor="rgba(0,0,0,0.5)"
        >
          {/* Progress bar */}
          <YStack
            height={4}
            backgroundColor="$gray8"
            borderRadius={2}
            marginBottom="$3"
          >
            <YStack
              height={4}
              backgroundColor="$orange10"
              borderRadius={2}
              width={`${progress * 100}%`}
            />
          </YStack>
          
          {/* Controls */}
          <XStack justifyContent="space-between" alignItems="center">
            <Button
              variant="ghost"
              size="sm"
              circular
              onPress={togglePlayPause}
            >
              {isPlaying ? (
                <Pause size={24} color="white" />
              ) : (
                <Play size={24} color="white" />
              )}
            </Button>
            
            <Text color="white" fontSize="$2">
              {formatTime(progress * duration)} / {formatTime(duration)}
            </Text>
            
            <Button
              variant="ghost"
              size="sm"
              circular
              onPress={toggleMute}
            >
              {isMuted ? (
                <VolumeX size={24} color="white" />
              ) : (
                <Volume2 size={24} color="white" />
              )}
            </Button>
          </XStack>
        </YStack>
      )}
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
      // Load main bondfire video URL
      const mainUrl = await getVideoUrls({
        hdKey: bondfireData.videoKey,
        sdKey: bondfireData.sdVideoKey,
      })
      
      // Load response video URLs
      const responseUrls = await Promise.all(
        bondfireData.videos.map((v) =>
          getVideoUrls({ hdKey: v.videoKey, sdKey: v.sdVideoKey })
        )
      )
      
      setVideoUrls([mainUrl.hdUrl, ...responseUrls.map((r) => r.hdUrl)])
    }
    
    loadUrls()
    
    // Record view
    incrementViews({ bondfireId })
  }, [bondfireData])
  
  const handleVideoComplete = useCallback(() => {
    if (!bondfireData) return
    
    // Record completion event
    recordWatchEvent({
      videoType: currentVideoIndex === 0 ? 'bondfire' : 'response',
      videoId: currentVideoIndex === 0
        ? bondfireData._id
        : bondfireData.videos[currentVideoIndex - 1]._id,
      eventType: 'complete',
      positionMs: 0,
    })
    
    // Move to next video
    if (currentVideoIndex < videoUrls.length - 1) {
      setCurrentVideoIndex(currentVideoIndex + 1)
    }
  }, [bondfireData, currentVideoIndex, videoUrls.length, recordWatchEvent])
  
  const handleProgress = useCallback((progress: number) => {
    if (!bondfireData) return
    
    const videoId = currentVideoIndex === 0
      ? bondfireData._id
      : bondfireData.videos[currentVideoIndex - 1]._id
    const videoType = currentVideoIndex === 0 ? 'bondfire' : 'response'
    
    // Record milestone events
    const milestones = [0.25, 0.5, 0.75]
    milestones.forEach((milestone) => {
      if (progress >= milestone && progress < milestone + 0.05) {
        const eventType = `milestone_${Math.round(milestone * 100)}` as 'milestone_25' | 'milestone_50' | 'milestone_75'
        recordWatchEvent({
          videoType,
          videoId,
          eventType,
          positionMs: Math.round(progress * 1000),
        })
      }
    })
  }, [bondfireData, currentVideoIndex, recordWatchEvent])
  
  const handleRespond = useCallback(() => {
    router.push(`/(main)/create?respondTo=${id}`)
  }, [router, id])
  
  if (!bondfireData) {
    return (
      <Container centered>
        <Spinner size="large" color="$orange10" />
      </Container>
    )
  }
  
  const totalVideos = 1 + bondfireData.videos.length
  
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      
      <YStack flex={1} backgroundColor="$background">
        {/* Header */}
        <XStack
          paddingTop="$6"
          paddingHorizontal="$4"
          paddingBottom="$2"
          justifyContent="space-between"
          alignItems="center"
          backgroundColor="$background"
        >
          <Button variant="ghost" size="sm" onPress={() => router.back()}>
            <ChevronLeft size={24} />
          </Button>
          
          <Text fontWeight="600">
            Video {currentVideoIndex + 1} of {totalVideos}
          </Text>
          
          {currentVideoIndex < totalVideos - 1 && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setCurrentVideoIndex(currentVideoIndex + 1)}
            >
              <SkipForward size={24} />
            </Button>
          )}
        </XStack>
        
        {/* Video player */}
        <YStack flex={1}>
          <VideoPlayer
            videoUrl={videoUrls[currentVideoIndex] ?? null}
            isActive={true}
            onComplete={handleVideoComplete}
            onProgress={handleProgress}
          />
        </YStack>
        
        {/* Video info and actions */}
        <YStack padding="$4" gap="$3" backgroundColor="$background">
          <XStack justifyContent="space-between" alignItems="center">
            <YStack>
              <Text fontWeight="600" fontSize="$4">
                {currentVideoIndex === 0
                  ? bondfireData.creatorName ?? 'Anonymous'
                  : bondfireData.videos[currentVideoIndex - 1]?.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize="$2" color="$gray11">
                {currentVideoIndex === 0 ? 'Original' : `Response ${currentVideoIndex}`}
              </Text>
            </YStack>
            
            <XStack gap="$2">
              <Text color="$gray11" fontSize="$2">
                👁 {bondfireData.viewCount ?? 0}
              </Text>
              <Text color="$gray11" fontSize="$2">
                🔥 {bondfireData.videoCount}
              </Text>
            </XStack>
          </XStack>
          
          {/* Video navigation dots */}
          <XStack justifyContent="center" gap="$2">
            {Array.from({ length: totalVideos }).map((_, i) => (
              <Pressable key={i} onPress={() => setCurrentVideoIndex(i)}>
                <YStack
                  width={i === currentVideoIndex ? 24 : 8}
                  height={8}
                  borderRadius={4}
                  backgroundColor={i === currentVideoIndex ? '$orange10' : '$gray6'}
                />
              </Pressable>
            ))}
          </XStack>
          
          <Button variant="primary" size="lg" onPress={handleRespond}>
            Add Your Response
          </Button>
        </YStack>
      </YStack>
    </>
  )
}

