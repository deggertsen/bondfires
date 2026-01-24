import { cancelProcessing, startBackgroundUpload } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { Flame, FlipHorizontal, X } from '@tamagui/lucide-icons'
import { useAction, useMutation } from 'convex/react'
import {
  type CameraType,
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useIsFocused } from '@react-navigation/native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, Pressable, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../components/CompletionScreen'

const MAX_DURATION = 60 // 60 seconds max

type RecordingState = 'idle' | 'recording' | 'completion' | 'processing' | 'uploading'

export default function CreateScreen() {
  const router = useRouter()
  const { respondTo } = useLocalSearchParams<{ respondTo?: string }>()
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()

  const cameraRef = useRef<CameraView>(null)
  const [facing, setFacing] = useState<CameraType>('back')
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [videoUri, setVideoUri] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressStage, setProgressStage] = useState<string>('')
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active')

  const createBondfire = useMutation(api.bondfires.create)
  const addResponse = useMutation(api.bondfireVideos.addResponse)
  const getUploadUrls = useAction(api.videos.getUploadUrls)
  const keepAwakeTag = 'create-recording'

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
    }
  }, [])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppActive(state === 'active')
    })

    return () => {
      subscription.remove()
    }
  }, [])

  // Keep screen awake while recording or processing
  useEffect(() => {
    const shouldKeepAwake =
      isFocused &&
      isAppActive &&
      (recordingState === 'recording' ||
        recordingState === 'processing' ||
        recordingState === 'uploading')

    if (shouldKeepAwake) {
      activateKeepAwakeAsync(keepAwakeTag)
    } else {
      deactivateKeepAwake(keepAwakeTag)
    }

    return () => {
      deactivateKeepAwake(keepAwakeTag)
    }
  }, [recordingState, isFocused, isAppActive, keepAwakeTag])

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
        setRecordingState('completion')
        // Start background upload immediately
        queueBackgroundUpload(video.uri)
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

  const queueBackgroundUpload = useCallback(
    async (uri: string) => {
      try {
        await startBackgroundUpload({
          videoUri: uri,
          bondfireId: respondTo,
          isResponse: !!respondTo,
          getUploadUrls: async (args) => {
            return await getUploadUrls(args)
          },
          createBondfire: async (args) => {
            await createBondfire(args)
          },
          addResponse: async (args) => {
            await addResponse({
              ...args,
              bondfireId: respondTo as Id<'bondfires'>,
            })
          },
          callbacks: {
            onProgress: (progress, stage) => {
              setProgress(progress)
              setProgressStage(stage)
            },
            onComplete: () => {
              console.info('Upload completed')
            },
            onError: (error) => {
              console.error('Upload error:', error)
              Alert.alert('Upload Error', 'Failed to upload video. It will retry automatically.')
            },
          },
        })
      } catch (error) {
        console.error('Failed to queue upload:', error)
        Alert.alert('Error', 'Failed to start upload. Please try again.')
      }
    },
    [respondTo, getUploadUrls, createBondfire, addResponse],
  )

  const toggleFacing = useCallback(() => {
    setFacing((current) => (current === 'back' ? 'front' : 'back'))
  }, [])

  // Permission denied state
  if (!cameraPermission?.granted || !micPermission?.granted) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        paddingHorizontal={24}
      >
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

  // Completion screen - shown immediately after recording
  if (recordingState === 'completion' && videoUri) {
    return <CompletionScreen onContinue={() => router.replace('/(main)/feed')} />
  }

  // Processing state
  if (recordingState === 'processing') {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
      >
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
              setRecordingState('idle')
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
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
      >
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
              backgroundColor={
                recordingState === 'recording' ? bondfireColors.error : 'transparent'
              }
            >
              <YStack
                width={recordingState === 'recording' ? 30 : 60}
                height={recordingState === 'recording' ? 30 : 60}
                borderRadius={recordingState === 'recording' ? 6 : 30}
                backgroundColor={
                  recordingState === 'recording'
                    ? bondfireColors.whiteSmoke
                    : bondfireColors.bondfireCopper
                }
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
