import { cancelProcessing, startBackgroundUpload } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Flame, SwitchCamera, X } from '@tamagui/lucide-icons'
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
import { useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Platform, Pressable, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../../components/CompletionScreen'

type RecordingState = 'idle' | 'recording' | 'completion' | 'processing' | 'uploading'

export default function CreateScreen() {
  const router = useRouter()
  const { respondTo } = useLocalSearchParams<{ respondTo?: string }>()
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()

  const cameraRef = useRef<CameraView>(null)
  const isStartingRecordingRef = useRef(false)
  const wasFocusedRef = useRef(isFocused)

  const state$ = useObservable({
    facing: 'front' as CameraType,
    recordingState: 'idle' as RecordingState,
    recordingDuration: 0,
    videoUri: null as string | null,
    progress: 0,
    progressStage: '',
    isAppActive: AppState.currentState === 'active',
    isFocused: isFocused,
    isCameraReady: false,
    cameraMountError: null as string | null,
  })

  const facing = useValue(state$.facing)
  const recordingState = useValue(state$.recordingState)
  const recordingDuration = useValue(state$.recordingDuration)
  const videoUri = useValue(state$.videoUri)
  const progress = useValue(state$.progress)
  const progressStage = useValue(state$.progressStage)
  const isAppActive = useValue(state$.isAppActive)
  const isCameraReady = useValue(state$.isCameraReady)

  const createBondfire = useMutation(api.bondfires.create)
  const addResponse = useMutation(api.bondfireVideos.addResponse)
  const getUploadUrls = useAction(api.videos.getUploadUrls)
  const keepAwakeTag = 'create-recording'

  // Recording timer (interval-based - keep useEffect)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined

    if (recordingState === 'recording') {
      interval = setInterval(() => {
        state$.recordingDuration.set((prev) => prev + 1)
      }, 1000)
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [recordingState, state$])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelProcessing()
    }
  }, [])

  // Track app active state (external subscription - keep useEffect)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (appState) => {
      state$.isAppActive.set(appState === 'active')
    })

    return () => {
      subscription.remove()
    }
  }, [state$])

  // Sync isFocused from hook to observable
  useEffect(() => {
    state$.isFocused.set(isFocused)
  }, [isFocused, state$])

  // Camera readiness should be re-established on focus changes.
  useEffect(() => {
    if (!isFocused) {
      state$.isCameraReady.set(false)
      state$.cameraMountError.set(null)
      isStartingRecordingRef.current = false
    }
  }, [isFocused, state$])

  // Reset completion state only after returning to this tab from another screen.
  // This avoids immediately clearing completion right after recordAsync resolves.
  useEffect(() => {
    const wasFocused = wasFocusedRef.current
    wasFocusedRef.current = isFocused

    if (!isFocused || wasFocused) {
      return
    }

    if (state$.recordingState.get() === 'completion') {
      state$.recordingState.set('idle')
      state$.videoUri.set(null)
      state$.recordingDuration.set(0)
      state$.progress.set(0)
      state$.progressStage.set('')
      // Clear respondTo param so user can create a new spark instead of responding.
      if (respondTo) {
        router.replace('/(main)/(tabs)/create')
      }
    }
  }, [isFocused, respondTo, router, state$])

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
  }, [recordingState, isFocused, isAppActive])

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

  const logRecordingError = useCallback(
    (error: unknown) => {
      type ErrorLike = { message?: unknown; name?: unknown; stack?: unknown }
      const errObj: ErrorLike | undefined =
        typeof error === 'object' && error !== null ? (error as ErrorLike) : undefined

      const name = typeof errObj?.name === 'string' ? errObj.name : undefined
      const stack = typeof errObj?.stack === 'string' ? errObj.stack : undefined
      const messageFromObj = typeof errObj?.message === 'string' ? errObj.message : undefined

      let message = messageFromObj ?? (typeof error === 'string' ? error : undefined)
      if (!message) {
        try {
          message = JSON.stringify(error)
        } catch {
          message = 'Unknown error'
        }
      }

      console.error('Recording error:', {
        platform: Platform.OS,
        message,
        name,
        stack,
        cameraPermission: cameraPermission?.status,
        micPermission: micPermission?.status,
        isFocused: state$.isFocused.get(),
        isAppActive: state$.isAppActive.get(),
        isCameraReady: state$.isCameraReady.get(),
        recordingState: state$.recordingState.get(),
      })
    },
    [cameraPermission?.status, micPermission?.status, state$],
  )

  const startRecording = useCallback(async () => {
    if (!cameraRef.current) {
      Alert.alert('Camera Not Ready', 'Please wait a moment and try again.')
      return
    }

    // Prevent double-taps / re-entrancy before React has re-rendered with the new state.
    if (isStartingRecordingRef.current || state$.recordingState.get() === 'recording') {
      return
    }

    if (!state$.isFocused.get() || !state$.isAppActive.get()) {
      Alert.alert('Camera Not Ready', 'Please return to the app and try again.')
      return
    }

    // expo-camera explicitly requires waiting for onCameraReady before calling recordAsync.
    if (!state$.isCameraReady.get()) {
      Alert.alert('Camera Initializing', 'Please wait a moment and try again.')
      return
    }

    isStartingRecordingRef.current = true
    state$.recordingState.set('recording')
    state$.recordingDuration.set(0)

    try {
      const video = await cameraRef.current.recordAsync()

      if (video?.uri) {
        state$.videoUri.set(video.uri)
        state$.recordingState.set('completion')
        // Start background upload immediately
        queueBackgroundUpload(video.uri)
      } else {
        // recordAsync() resolved without a URI (known iOS edge case)
        console.warn('Recording returned no URI')
        state$.recordingState.set('idle')
        Alert.alert('Recording Failed', 'No video was captured. Please try again.')
      }
    } catch (error) {
      logRecordingError(error)
      state$.recordingState.set('idle')
      Alert.alert('Error', 'Failed to record video. Please try again.')
    } finally {
      isStartingRecordingRef.current = false
    }
  }, [logRecordingError, state$])

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
            onProgress: (progressValue, stage) => {
              state$.progress.set(progressValue)
              state$.progressStage.set(stage)
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
    [respondTo, getUploadUrls, createBondfire, addResponse, state$],
  )

  const toggleFacing = useCallback(() => {
    state$.facing.set((current) => (current === 'back' ? 'front' : 'back'))
  }, [state$])

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
    return <CompletionScreen onContinue={() => router.replace('/(main)/(tabs)/feed')} />
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
              state$.recordingState.set('idle')
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
      <CameraView
        ref={cameraRef}
        style={{ flex: 1 }}
        facing={facing}
        mode="video"
        onCameraReady={() => {
          state$.isCameraReady.set(true)
          state$.cameraMountError.set(null)
        }}
        onMountError={(event) => {
          const message = event?.message ?? 'Unknown camera mount error'
          state$.cameraMountError.set(message)
          state$.isCameraReady.set(false)
          console.error('Camera mount error:', { platform: Platform.OS, message })
          Alert.alert('Camera Error', message)
        }}
      >
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
              <SwitchCamera size={22} color={bondfireColors.whiteSmoke} />
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
          <Pressable
            disabled={!isCameraReady && recordingState !== 'recording'}
            onPress={recordingState === 'recording' ? stopRecording : startRecording}
          >
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
              opacity={!isCameraReady && recordingState !== 'recording' ? 0.5 : 1}
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
            {recordingState === 'recording'
              ? 'Tap to stop'
              : isCameraReady
                ? 'Tap to record'
                : 'Initializing camera...'}
          </Text>
        </YStack>
      </CameraView>
    </YStack>
  )
}
