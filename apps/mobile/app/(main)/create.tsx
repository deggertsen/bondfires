import { useState, useRef, useCallback, useEffect } from 'react'
import { Dimensions, Pressable, Alert } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { YStack, XStack, Spinner } from 'tamagui'
import { Container, Button, Text } from '@bondfires/ui'
import { CameraView, CameraType, useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { useMutation, useAction } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { Id } from '../../../convex/_generated/dataModel'
import { Video, ResizeMode } from 'expo-av'
import { FlipHorizontal, X, Check } from '@tamagui/lucide-icons'
import { processVideo, cleanupTempVideos, cancelProcessing, CompressionProgress } from '@bondfires/app'

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')
const MAX_DURATION = 60 // 60 seconds max

type RecordingState = 'idle' | 'recording' | 'preview' | 'processing' | 'uploading'

export default function CreateScreen() {
  const router = useRouter()
  const { respondTo } = useLocalSearchParams<{ respondTo?: string }>()
  
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()
  
  const cameraRef = useRef<CameraView>(null)
  const [facing, setFacing] = useState<CameraType>('back')
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [videoUri, setVideoUri] = useState<string | null>(null)
  const [processedVideo, setProcessedVideo] = useState<{
    hdUri: string
    sdUri: string
    thumbnailUri: string
  } | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressStage, setProgressStage] = useState<string>('')
  
  const createBondfire = useMutation(api.bondfires.create)
  const addResponse = useMutation(api.bondfireVideos.addResponse)
  const getUploadUrls = useAction(api.videos.getUploadUrls)
  
  // Recording timer
  useEffect(() => {
    let interval: NodeJS.Timeout
    
    if (recordingState === 'recording') {
      interval = setInterval(() => {
        setRecordingDuration((prev) => {
          if (prev >= MAX_DURATION) {
            stopRecording()
            return MAX_DURATION
          }
          return prev + 1
        })
      }, 1000)
    }
    
    return () => clearInterval(interval)
  }, [recordingState])
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelProcessing()
      if (processedVideo) {
        cleanupTempVideos([
          processedVideo.hdUri,
          processedVideo.sdUri,
          processedVideo.thumbnailUri,
        ])
      }
    }
  }, [processedVideo])
  
  const requestPermissions = useCallback(async () => {
    if (!cameraPermission?.granted) {
      await requestCameraPermission()
    }
    if (!micPermission?.granted) {
      await requestMicPermission()
    }
  }, [cameraPermission, micPermission, requestCameraPermission, requestMicPermission])
  
  useEffect(() => {
    requestPermissions()
  }, [requestPermissions])
  
  const startRecording = useCallback(async () => {
    if (!cameraRef.current) return
    
    setRecordingState('recording')
    setRecordingDuration(0)
    
    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION,
      })
      
      if (video?.uri) {
        setVideoUri(video.uri)
        setRecordingState('preview')
      }
    } catch (error) {
      console.error('Recording error:', error)
      setRecordingState('idle')
      Alert.alert('Error', 'Failed to record video. Please try again.')
    }
  }, [])
  
  const stopRecording = useCallback(() => {
    if (cameraRef.current) {
      cameraRef.current.stopRecording()
    }
  }, [])
  
  const discardRecording = useCallback(() => {
    setVideoUri(null)
    setProcessedVideo(null)
    setRecordingState('idle')
    setRecordingDuration(0)
    setProgress(0)
  }, [])
  
  const handleProgressUpdate = useCallback((update: CompressionProgress) => {
    setProgress(update.percentage)
    switch (update.stage) {
      case 'hd':
        setProgressStage('Compressing HD...')
        break
      case 'sd':
        setProgressStage('Creating SD version...')
        break
      case 'thumbnail':
        setProgressStage('Generating thumbnail...')
        break
    }
  }, [])
  
  const processAndUpload = useCallback(async () => {
    if (!videoUri) return
    
    setRecordingState('processing')
    setProgress(0)
    setProgressStage('Starting compression...')
    
    try {
      // Process video (compress to HD/SD, extract thumbnail)
      const processed = await processVideo(videoUri, handleProgressUpdate)
      setProcessedVideo(processed)
      
      // Now upload
      setRecordingState('uploading')
      setProgress(0)
      setProgressStage('Uploading...')
      
      // Get presigned upload URLs
      const filename = `bondfire-${Date.now()}.mp4`
      const urls = await getUploadUrls({
        filename,
        contentType: 'video/mp4',
      })
      
      setProgress(10)
      
      // Upload HD video
      const hdFile = await fetch(processed.hdUri)
      const hdBlob = await hdFile.blob()
      
      await fetch(urls.hdUrl, {
        method: 'PUT',
        body: hdBlob,
        headers: { 'Content-Type': 'video/mp4' },
      })
      
      setProgress(40)
      
      // Upload SD video
      const sdFile = await fetch(processed.sdUri)
      const sdBlob = await sdFile.blob()
      
      await fetch(urls.sdUrl, {
        method: 'PUT',
        body: sdBlob,
        headers: { 'Content-Type': 'video/mp4' },
      })
      
      setProgress(70)
      
      // Upload thumbnail
      const thumbFile = await fetch(processed.thumbnailUri)
      const thumbBlob = await thumbFile.blob()
      
      await fetch(urls.thumbnailUrl, {
        method: 'PUT',
        body: thumbBlob,
        headers: { 'Content-Type': 'image/jpeg' },
      })
      
      setProgress(85)
      
      // Create bondfire or response in database
      if (respondTo) {
        await addResponse({
          bondfireId: respondTo as Id<'bondfires'>,
          videoKey: urls.hdKey,
          sdVideoKey: urls.sdKey,
          thumbnailKey: urls.thumbnailKey,
          durationMs: processed.metadata.durationMs,
          width: processed.metadata.width,
          height: processed.metadata.height,
        })
      } else {
        await createBondfire({
          videoKey: urls.hdKey,
          sdVideoKey: urls.sdKey,
          thumbnailKey: urls.thumbnailKey,
          durationMs: processed.metadata.durationMs,
          width: processed.metadata.width,
          height: processed.metadata.height,
        })
      }
      
      setProgress(100)
      
      // Cleanup temp files
      await cleanupTempVideos([
        processed.hdUri,
        processed.sdUri,
        processed.thumbnailUri,
      ])
      
      // Navigate back to feed
      router.replace('/(main)/feed')
    } catch (error) {
      console.error('Processing/upload error:', error)
      Alert.alert('Error', 'Failed to process or upload video. Please try again.')
      setRecordingState('preview')
    }
  }, [videoUri, getUploadUrls, createBondfire, addResponse, respondTo, router, handleProgressUpdate])
  
  const toggleFacing = useCallback(() => {
    setFacing((current) => (current === 'back' ? 'front' : 'back'))
  }, [])
  
  // Permission denied state
  if (!cameraPermission?.granted || !micPermission?.granted) {
    return (
      <Container centered padded>
        <YStack alignItems="center" gap="$4">
          <Text fontSize={60}>📹</Text>
          <Text textAlign="center" fontSize="$4">
            Camera and microphone access required
          </Text>
          <Text textAlign="center" color="$gray11">
            We need access to your camera and microphone to record videos.
          </Text>
          <Button variant="primary" size="lg" onPress={requestPermissions}>
            Grant Permissions
          </Button>
        </YStack>
      </Container>
    )
  }
  
  // Preview recorded video
  if (recordingState === 'preview' && videoUri) {
    return (
      <YStack flex={1} backgroundColor="black">
        <Video
          source={{ uri: videoUri }}
          style={{ flex: 1 }}
          resizeMode={ResizeMode.COVER}
          shouldPlay
          isLooping
        />
        
        <XStack
          position="absolute"
          bottom={50}
          left={0}
          right={0}
          justifyContent="center"
          gap="$6"
          paddingHorizontal="$4"
        >
          <Button
            variant="outline"
            size="lg"
            circular
            width={70}
            height={70}
            onPress={discardRecording}
          >
            <X size={32} color="white" />
          </Button>
          
          <Button
            variant="primary"
            size="lg"
            circular
            width={70}
            height={70}
            onPress={processAndUpload}
          >
            <Check size={32} color="white" />
          </Button>
        </XStack>
        
        <YStack
          position="absolute"
          bottom={140}
          left={0}
          right={0}
          alignItems="center"
        >
          <Text color="rgba(255,255,255,0.7)" fontSize="$2">
            Tap ✓ to compress & upload
          </Text>
        </YStack>
      </YStack>
    )
  }
  
  // Processing state
  if (recordingState === 'processing') {
    return (
      <Container centered>
        <YStack alignItems="center" gap="$4">
          <Spinner size="large" color="$orange10" />
          <Text fontSize="$4" fontWeight="600">
            Processing Video
          </Text>
          <Text color="$gray11" fontSize="$2">
            {progressStage}
          </Text>
          <YStack width={200} height={8} backgroundColor="$gray4" borderRadius={4}>
            <YStack
              height={8}
              backgroundColor="$orange10"
              borderRadius={4}
              width={`${progress}%`}
            />
          </YStack>
          <Text color="$gray11">{Math.round(progress)}%</Text>
          
          <Button
            variant="ghost"
            size="sm"
            marginTop="$4"
            onPress={() => {
              cancelProcessing()
              setRecordingState('preview')
            }}
          >
            Cancel
          </Button>
        </YStack>
      </Container>
    )
  }
  
  // Uploading state
  if (recordingState === 'uploading') {
    return (
      <Container centered>
        <YStack alignItems="center" gap="$4">
          <Spinner size="large" color="$orange10" />
          <Text fontSize="$4" fontWeight="600">
            Uploading
          </Text>
          <Text color="$gray11" fontSize="$2">
            {progressStage}
          </Text>
          <YStack width={200} height={8} backgroundColor="$gray4" borderRadius={4}>
            <YStack
              height={8}
              backgroundColor="$green10"
              borderRadius={4}
              width={`${progress}%`}
            />
          </YStack>
          <Text color="$gray11">{Math.round(progress)}%</Text>
        </YStack>
      </Container>
    )
  }
  
  // Camera view
  return (
    <YStack flex={1} backgroundColor="black">
      <CameraView
        ref={cameraRef}
        style={{ flex: 1 }}
        facing={facing}
        mode="video"
      >
        {/* Header */}
        <XStack
          paddingTop="$8"
          paddingHorizontal="$4"
          justifyContent="space-between"
          alignItems="center"
        >
          <Button variant="ghost" size="sm" onPress={() => router.back()}>
            <X size={24} color="white" />
          </Button>
          
          {recordingState === 'recording' && (
            <YStack
              backgroundColor="$red10"
              paddingHorizontal="$3"
              paddingVertical="$1"
              borderRadius="$2"
            >
              <Text color="white" fontWeight="600">
                {Math.floor(recordingDuration / 60)}:{(recordingDuration % 60).toString().padStart(2, '0')}
              </Text>
            </YStack>
          )}
          
          <Button variant="ghost" size="sm" onPress={toggleFacing}>
            <FlipHorizontal size={24} color="white" />
          </Button>
        </XStack>
        
        {/* Title */}
        <YStack flex={1} justifyContent="center" alignItems="center">
          {recordingState === 'idle' && (
            <YStack alignItems="center" gap="$2">
              <Text color="white" fontSize="$5" fontWeight="600">
                {respondTo ? 'Add Your Response' : 'Spark a Bondfire'}
              </Text>
              <Text color="rgba(255,255,255,0.7)" fontSize="$2">
                Hold the button to record
              </Text>
            </YStack>
          )}
        </YStack>
        
        {/* Record button */}
        <YStack
          paddingBottom="$10"
          alignItems="center"
        >
          <Pressable
            onPressIn={startRecording}
            onPressOut={stopRecording}
          >
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              borderWidth={4}
              borderColor="white"
              alignItems="center"
              justifyContent="center"
              backgroundColor={recordingState === 'recording' ? '$red10' : 'transparent'}
            >
              <YStack
                width={recordingState === 'recording' ? 30 : 60}
                height={recordingState === 'recording' ? 30 : 60}
                borderRadius={recordingState === 'recording' ? 4 : 30}
                backgroundColor={recordingState === 'recording' ? 'white' : '$red10'}
              />
            </YStack>
          </Pressable>
          
          <Text color="rgba(255,255,255,0.7)" fontSize="$2" marginTop="$2">
            Max {MAX_DURATION} seconds
          </Text>
        </YStack>
      </CameraView>
    </YStack>
  )
}
