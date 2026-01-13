import {
  type CompressionProgress,
  cancelProcessing,
  cleanupTempVideos,
  processVideo,
} from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { Check, FlipHorizontal, X, Flame } from '@tamagui/lucide-icons'
import { useAction, useMutation } from 'convex/react'
import { ResizeMode, Video } from 'expo-av'
import {
  type CameraType,
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

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
    let interval: ReturnType<typeof setInterval> | undefined

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

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [recordingState])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelProcessing()
      if (processedVideo) {
        cleanupTempVideos([processedVideo.hdUri, processedVideo.sdUri, processedVideo.thumbnailUri])
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
      await cleanupTempVideos([processed.hdUri, processed.sdUri, processed.thumbnailUri])

      // Navigate back to feed
      router.replace('/(main)/feed')
    } catch (error) {
      console.error('Processing/upload error:', error)
      Alert.alert('Error', 'Failed to process or upload video. Please try again.')
      setRecordingState('preview')
    }
  }, [
    videoUri,
    getUploadUrls,
    createBondfire,
    addResponse,
    respondTo,
    router,
    handleProgressUpdate,
  ])

  const toggleFacing = useCallback(() => {
    setFacing((current) => (current === 'back' ? 'front' : 'back'))
  }, [])

  // Permission denied state
  if (!cameraPermission?.granted || !micPermission?.granted) {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian} alignItems="center" justifyContent="center" paddingHorizontal={24}>
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack alignItems="center" gap={24}>
          <YStack
            width={100}
            height={100}
            borderRadius={50}
            backgroundColor={bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor={bondfireColors.bondfireCopper}
          >
            <Flame size={50} color={bondfireColors.bondfireCopper} />
          </YStack>
          <Text fontSize={20} fontWeight="600" textAlign="center">
            Camera and microphone access required
          </Text>
          <Text textAlign="center" color={bondfireColors.ash}>
            We need access to your camera and microphone to record videos.
          </Text>
          <Button variant="primary" size="$lg" onPress={requestPermissions}>
            Grant Permissions
          </Button>
        </YStack>
      </YStack>
    )
  }

  // Preview recorded video
  if (recordingState === 'preview' && videoUri) {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
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
          gap={40}
          paddingHorizontal={24}
        >
          <Pressable onPress={discardRecording}>
            <YStack
              width={70}
              height={70}
              borderRadius={35}
              backgroundColor="rgba(31, 32, 35, 0.8)"
              borderWidth={2}
              borderColor={bondfireColors.iron}
              alignItems="center"
              justifyContent="center"
            >
              <X size={32} color={bondfireColors.whiteSmoke} />
            </YStack>
          </Pressable>

          <Pressable onPress={processAndUpload}>
            <YStack
              width={70}
              height={70}
              borderRadius={35}
              backgroundColor={bondfireColors.bondfireCopper}
              alignItems="center"
              justifyContent="center"
            >
              <Check size={32} color={bondfireColors.whiteSmoke} />
            </YStack>
          </Pressable>
        </XStack>

        <YStack position="absolute" bottom={140} left={0} right={0} alignItems="center">
          <Text color={bondfireColors.ash} fontSize={14}>
            Tap ✓ to compress & upload
          </Text>
        </YStack>
      </YStack>
    )
  }

  // Processing state
  if (recordingState === 'processing') {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian} alignItems="center" justifyContent="center">
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack alignItems="center" gap={20}>
          <Spinner size="large" color={bondfireColors.bondfireCopper} />
          <Text fontSize={20} fontWeight="600">
            Processing Video
          </Text>
          <Text color={bondfireColors.ash} fontSize={14}>
            {progressStage}
          </Text>
          <YStack width={200} height={6} backgroundColor={bondfireColors.iron} borderRadius={3}>
            <YStack
              height={6}
              backgroundColor={bondfireColors.bondfireCopper}
              borderRadius={3}
              width={`${progress}%`}
            />
          </YStack>
          <Text color={bondfireColors.ash}>{Math.round(progress)}%</Text>

          <Button
            variant="ghost"
            size="$sm"
            marginTop={16}
            onPress={() => {
              cancelProcessing()
              setRecordingState('preview')
            }}
          >
            Cancel
          </Button>
        </YStack>
      </YStack>
    )
  }

  // Uploading state
  if (recordingState === 'uploading') {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian} alignItems="center" justifyContent="center">
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack alignItems="center" gap={20}>
          <Spinner size="large" color={bondfireColors.success} />
          <Text fontSize={20} fontWeight="600">
            Uploading
          </Text>
          <Text color={bondfireColors.ash} fontSize={14}>
            {progressStage}
          </Text>
          <YStack width={200} height={6} backgroundColor={bondfireColors.iron} borderRadius={3}>
            <YStack
              height={6}
              backgroundColor={bondfireColors.success}
              borderRadius={3}
              width={`${progress}%`}
            />
          </YStack>
          <Text color={bondfireColors.ash}>{Math.round(progress)}%</Text>
        </YStack>
      </YStack>
    )
  }

  // Camera view
  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <CameraView ref={cameraRef} style={{ flex: 1 }} facing={facing} mode="video">
        {/* Header */}
        <XStack
          paddingTop={60}
          paddingHorizontal={20}
          justifyContent="space-between"
          alignItems="center"
        >
          <Pressable onPress={() => router.back()}>
            <YStack
              width={40}
              height={40}
              borderRadius={20}
              backgroundColor="rgba(31, 32, 35, 0.7)"
              alignItems="center"
              justifyContent="center"
            >
              <X size={24} color={bondfireColors.whiteSmoke} />
            </YStack>
          </Pressable>

          {recordingState === 'recording' && (
            <YStack
              backgroundColor={bondfireColors.error}
              paddingHorizontal={16}
              paddingVertical={6}
              borderRadius={16}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="700" fontSize={14}>
                {Math.floor(recordingDuration / 60)}:
                {(recordingDuration % 60).toString().padStart(2, '0')}
              </Text>
            </YStack>
          )}

          <Pressable onPress={toggleFacing}>
            <YStack
              width={40}
              height={40}
              borderRadius={20}
              backgroundColor="rgba(31, 32, 35, 0.7)"
              alignItems="center"
              justifyContent="center"
            >
              <FlipHorizontal size={22} color={bondfireColors.whiteSmoke} />
            </YStack>
          </Pressable>
        </XStack>

        {/* Title */}
        <YStack flex={1} justifyContent="center" alignItems="center">
          {recordingState === 'idle' && (
            <YStack alignItems="center" gap={12}>
              <XStack alignItems="center" gap={8}>
                <Flame size={28} color={bondfireColors.bondfireCopper} />
                <Text color={bondfireColors.whiteSmoke} fontSize={22} fontWeight="700">
                  {respondTo ? 'Add Your Response' : 'Spark a Bondfire'}
                </Text>
              </XStack>
              <Text color={bondfireColors.ash} fontSize={14}>
                Tap to start recording
              </Text>
            </YStack>
          )}
        </YStack>

        {/* Record button */}
        <YStack paddingBottom={40} alignItems="center">
          <Pressable onPress={recordingState === 'recording' ? stopRecording : startRecording}>
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              borderWidth={4}
              borderColor={bondfireColors.whiteSmoke}
              alignItems="center"
              justifyContent="center"
              backgroundColor={recordingState === 'recording' ? bondfireColors.error : 'transparent'}
            >
              <YStack
                width={recordingState === 'recording' ? 30 : 60}
                height={recordingState === 'recording' ? 30 : 60}
                borderRadius={recordingState === 'recording' ? 6 : 30}
                backgroundColor={recordingState === 'recording' ? bondfireColors.whiteSmoke : bondfireColors.bondfireCopper}
              />
            </YStack>
          </Pressable>

          <Text color={bondfireColors.ash} fontSize={13} marginTop={12}>
            {recordingState === 'recording' ? 'Tap to stop' : `Max ${MAX_DURATION} seconds`}
          </Text>
        </YStack>
      </CameraView>
    </YStack>
  )
}
