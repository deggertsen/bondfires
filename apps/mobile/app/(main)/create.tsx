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
import { FlipHorizontal, X, Check, RefreshCw } from '@tamagui/lucide-icons'

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')
const MAX_DURATION = 60 // 60 seconds max

type RecordingState = 'idle' | 'recording' | 'preview' | 'uploading'

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
  const [uploadProgress, setUploadProgress] = useState(0)
  
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
    setRecordingState('idle')
    setRecordingDuration(0)
  }, [])
  
  const uploadVideo = useCallback(async () => {
    if (!videoUri) return
    
    setRecordingState('uploading')
    setUploadProgress(0)
    
    try {
      // Get presigned upload URLs
      const filename = `bondfire-${Date.now()}.mp4`
      const urls = await getUploadUrls({
        filename,
        contentType: 'video/mp4',
      })
      
      setUploadProgress(10)
      
      // Upload HD video
      const videoFile = await fetch(videoUri)
      const videoBlob = await videoFile.blob()
      
      const uploadResponse = await fetch(urls.hdUrl, {
        method: 'PUT',
        body: videoBlob,
        headers: {
          'Content-Type': 'video/mp4',
        },
      })
      
      if (!uploadResponse.ok) {
        throw new Error('Failed to upload video')
      }
      
      setUploadProgress(70)
      
      // Create bondfire or response in database
      if (respondTo) {
        // Adding a response to existing bondfire
        await addResponse({
          bondfireId: respondTo as Id<'bondfires'>,
          videoKey: urls.hdKey,
          sdVideoKey: urls.sdKey,
          thumbnailKey: urls.thumbnailKey,
        })
      } else {
        // Creating a new bondfire
        await createBondfire({
          videoKey: urls.hdKey,
          sdVideoKey: urls.sdKey,
          thumbnailKey: urls.thumbnailKey,
        })
      }
      
      setUploadProgress(100)
      
      // Navigate back to feed
      router.replace('/(main)/feed')
    } catch (error) {
      console.error('Upload error:', error)
      Alert.alert('Error', 'Failed to upload video. Please try again.')
      setRecordingState('preview')
    }
  }, [videoUri, getUploadUrls, createBondfire, addResponse, respondTo, router])
  
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
            onPress={uploadVideo}
          >
            <Check size={32} color="white" />
          </Button>
        </XStack>
      </YStack>
    )
  }
  
  // Uploading state
  if (recordingState === 'uploading') {
    return (
      <Container centered>
        <YStack alignItems="center" gap="$4">
          <Spinner size="large" color="$orange10" />
          <Text fontSize="$4" fontWeight="600">
            Uploading...
          </Text>
          <YStack width={200} height={8} backgroundColor="$gray4" borderRadius={4}>
            <YStack
              height={8}
              backgroundColor="$orange10"
              borderRadius={4}
              width={`${uploadProgress}%`}
            />
          </YStack>
          <Text color="$gray11">{uploadProgress}%</Text>
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
