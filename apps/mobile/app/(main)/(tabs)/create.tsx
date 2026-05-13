import {
  cancelProcessing,
  cleanupTempVideos,
  resumePendingUploads,
  startBackgroundUpload,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
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
import { useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Platform, Pressable, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../../components/CompletionScreen'
import { mergeVideoSegments } from '../../../lib/videoSegmentMerger'

type RecordingState = 'idle' | 'recording' | 'stopping' | 'completion' | 'processing' | 'uploading'

export default function CreateScreen() {
  const router = useRouter()
  const { respondTo } = useLocalSearchParams<{ respondTo?: string }>()
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()

  const cameraRef = useRef<CameraView>(null)
  const isStartingRecordingRef = useRef(false)
  const recordingSessionRef = useRef(0)
  const recordingActionRef = useRef<'none' | 'swap' | 'stop'>('none')
  const hasActiveSegmentRef = useRef(false)
  const recordedSegmentUrisRef = useRef<string[]>([])
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasFocusedRef = useRef(isFocused)

  const state$ = useObservable({
    facing: 'front' as CameraType,
    pendingFacing: null as CameraType | null,
    cameraResetCounter: 0,
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
  const cameraResetCounter = useValue(state$.cameraResetCounter)
  const recordingState = useValue(state$.recordingState)
  const recordingDuration = useValue(state$.recordingDuration)
  const videoUri = useValue(state$.videoUri)
  const progress = useValue(state$.progress)
  const progressStage = useValue(state$.progressStage)
  const isAppActive = useValue(state$.isAppActive)
  const isCameraReady = useValue(state$.isCameraReady)
  const cameraMountError = useValue(state$.cameraMountError)

  const createBondfire = useMutation(api.bondfires.create)
  const addResponse = useMutation(api.bondfireVideos.addResponse)
  const getBunnyUploadCredentials = useAction(api.videos.getBunnyUploadCredentials)
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
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current)
        stopTimeoutRef.current = null
      }
      if (uploadStartTimeoutRef.current) {
        clearTimeout(uploadStartTimeoutRef.current)
        uploadStartTimeoutRef.current = null
      }
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
      state$.pendingFacing.set(null)
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
        recordingState === 'stopping' ||
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

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current)
      stopTimeoutRef.current = null
    }
  }, [])

  const clearUploadStartTimeout = useCallback(() => {
    if (uploadStartTimeoutRef.current) {
      clearTimeout(uploadStartTimeoutRef.current)
      uploadStartTimeoutRef.current = null
    }
  }, [])

  const startPendingUploads = useCallback(async () => {
    await resumePendingUploads({
      isResponse: false,
      getBunnyUploadCredentials: async (args) => {
        return await getBunnyUploadCredentials(args)
      },
      createBondfire: async (args) => {
        await createBondfire(args)
      },
      addResponse: async (args) => {
        await addResponse({
          ...args,
          bondfireId: args.bondfireId as Id<'bondfires'>,
        })
      },
    })
  }, [getBunnyUploadCredentials, createBondfire, addResponse])

  const schedulePendingUploads = useCallback(() => {
    clearUploadStartTimeout()
    uploadStartTimeoutRef.current = setTimeout(() => {
      if (state$.isFocused.get()) {
        return
      }

      startPendingUploads().catch((error) => {
        console.error('Failed to start pending uploads:', error)
      })
    }, 1500)
  }, [clearUploadStartTimeout, startPendingUploads, state$])

  // Tear down the camera session whenever the screen or app becomes inactive.
  useEffect(() => {
    if (!isFocused || !isAppActive) {
      if (
        state$.recordingState.get() === 'recording' ||
        state$.recordingState.get() === 'stopping'
      ) {
        try {
          cameraRef.current?.stopRecording()
        } catch (error) {
          console.error('Failed to stop recording while screen lost focus:', error)
        }
        recordingSessionRef.current += 1
        recordingActionRef.current = 'none'
        hasActiveSegmentRef.current = false
        recordedSegmentUrisRef.current = []
        state$.recordingState.set('idle')
        state$.recordingDuration.set(0)
        state$.videoUri.set(null)
        state$.progress.set(0)
        state$.progressStage.set('')
      }

      state$.isCameraReady.set(false)
      state$.cameraMountError.set(null)
      cameraRef.current = null
      isStartingRecordingRef.current = false
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current)
        stopTimeoutRef.current = null
      }

      if (!isFocused) {
        schedulePendingUploads()
      }
    } else {
      clearUploadStartTimeout()
    }
  }, [clearUploadStartTimeout, isAppActive, isFocused, schedulePendingUploads, state$])

  const resetCameraPreview = useCallback(() => {
    clearStopTimeout()
    isStartingRecordingRef.current = false
    state$.isCameraReady.set(false)
    state$.cameraMountError.set(null)
    state$.cameraResetCounter.set((prev) => prev + 1)
  }, [clearStopTimeout, state$])

  const resetRecordingState = useCallback(() => {
    clearStopTimeout()
    clearUploadStartTimeout()
    recordingActionRef.current = 'none'
    hasActiveSegmentRef.current = false
    recordedSegmentUrisRef.current = []
    state$.recordingState.set('idle')
    state$.recordingDuration.set(0)
    state$.videoUri.set(null)
    state$.progress.set(0)
    state$.progressStage.set('')
    state$.pendingFacing.set(null)
  }, [clearStopTimeout, clearUploadStartTimeout, state$])

  const queueBackgroundUpload = useCallback(
    async (uri: string) => {
      try {
        return await startBackgroundUpload(
          {
            videoUri: uri,
            bondfireId: respondTo,
            isResponse: !!respondTo,
            getBunnyUploadCredentials: async (args) => {
              return await getBunnyUploadCredentials(args)
            },
            createBondfire: async (args) => {
              await createBondfire(args)
            },
            addResponse: async (args) => {
              await addResponse({
                ...args,
                bondfireId: args.bondfireId as Id<'bondfires'>,
              })
            },
          },
          false,
        )
      } catch (error) {
        console.error('Failed to queue upload:', error)
        Alert.alert('Error', 'Failed to start upload. Please try again.')
        return null
      }
    },
    [respondTo, getBunnyUploadCredentials, createBondfire, addResponse],
  )

  const finalizeRecording = useCallback(
    async (sessionId: number) => {
      const segmentUris = [...recordedSegmentUrisRef.current]

      if (segmentUris.length === 0) {
        resetRecordingState()
        Alert.alert('Recording Failed', 'No video was captured. Please try again.')
        return
      }

      state$.pendingFacing.set(null)
      state$.recordingState.set('processing')
      state$.progress.set(0)
      state$.progressStage.set(
        segmentUris.length > 1 ? 'Combining camera segments...' : 'Preparing video...',
      )

      let finalVideoUri = segmentUris[0]

      try {
        if (segmentUris.length > 1) {
          finalVideoUri = await mergeVideoSegments(segmentUris)
        }

        if (recordingSessionRef.current !== sessionId) {
          await cleanupTempVideos(
            finalVideoUri === segmentUris[0] ? segmentUris : [...segmentUris, finalVideoUri],
          )
          return
        }

        state$.videoUri.set(finalVideoUri)
        state$.recordingState.set('completion')
        const uploadTaskId = await queueBackgroundUpload(finalVideoUri)

        if (uploadTaskId) {
          await cleanupTempVideos(
            finalVideoUri === segmentUris[0] ? segmentUris : [...segmentUris, finalVideoUri],
          )
        }
      } catch (error) {
        logRecordingError(error)
        resetRecordingState()
        Alert.alert('Error', 'Failed to prepare the recording. Please try again.')
      }
    },
    [logRecordingError, queueBackgroundUpload, resetRecordingState, state$],
  )

  const startSegmentRecording = useCallback(
    async (sessionId: number) => {
      const activeCamera = cameraRef.current

      if (!activeCamera || !state$.isCameraReady.get()) {
        resetRecordingState()
        Alert.alert('Camera Not Ready', 'Please wait a moment and try again.')
        return
      }

      if (
        recordingSessionRef.current !== sessionId ||
        (state$.recordingState.get() !== 'recording' && state$.recordingState.get() !== 'stopping')
      ) {
        return
      }

      isStartingRecordingRef.current = true
      hasActiveSegmentRef.current = true

      try {
        const video = await activeCamera.recordAsync()
        hasActiveSegmentRef.current = false

        if (recordingSessionRef.current !== sessionId) {
          if (video?.uri) {
            await cleanupTempVideos([video.uri])
          }
          return
        }

        clearStopTimeout()

        if (!video?.uri) {
          resetRecordingState()
          Alert.alert('Recording Failed', 'No video was captured. Please try again.')
          return
        }

        recordedSegmentUrisRef.current.push(video.uri)

        if (recordingActionRef.current === 'swap') {
          const targetFacing = state$.pendingFacing.get()
          recordingActionRef.current = 'none'

          if (targetFacing && targetFacing !== state$.facing.get()) {
            state$.isCameraReady.set(false)
            state$.cameraMountError.set(null)
            state$.facing.set(targetFacing)
            return
          }

          state$.pendingFacing.set(null)
          void startSegmentRecording(sessionId)
          return
        }

        if (recordingActionRef.current === 'stop' || state$.recordingState.get() === 'stopping') {
          recordingActionRef.current = 'none'
          await finalizeRecording(sessionId)
          return
        }

        resetRecordingState()
        Alert.alert('Recording Failed', 'The recording stopped unexpectedly. Please try again.')
      } catch (error) {
        hasActiveSegmentRef.current = false

        if (recordingSessionRef.current !== sessionId) {
          return
        }

        clearStopTimeout()
        logRecordingError(error)
        resetRecordingState()
        Alert.alert('Error', 'Failed to record video. Please try again.')
      } finally {
        if (recordingSessionRef.current === sessionId) {
          isStartingRecordingRef.current = false
        }
      }
    },
    [clearStopTimeout, finalizeRecording, logRecordingError, resetRecordingState, state$],
  )

  const startRecording = useCallback(async () => {
    const activeCamera = cameraRef.current

    if (!activeCamera) {
      Alert.alert('Camera Not Ready', 'Please wait a moment and try again.')
      return
    }

    // Prevent double-taps / re-entrancy before React has re-rendered with the new state.
    const currentRecordingState = state$.recordingState.get()

    if (
      isStartingRecordingRef.current ||
      currentRecordingState === 'recording' ||
      currentRecordingState === 'stopping'
    ) {
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
    clearStopTimeout()
    clearUploadStartTimeout()
    const sessionId = recordingSessionRef.current + 1
    recordingSessionRef.current = sessionId
    recordingActionRef.current = 'none'
    hasActiveSegmentRef.current = false
    recordedSegmentUrisRef.current = []
    state$.recordingState.set('recording')
    state$.recordingDuration.set(0)
    state$.videoUri.set(null)
    state$.progress.set(0)
    state$.progressStage.set('')
    state$.pendingFacing.set(null)

    try {
      await startSegmentRecording(sessionId)
    } catch (error) {
      if (recordingSessionRef.current !== sessionId) {
        return
      }

      clearStopTimeout()
      logRecordingError(error)
      resetRecordingState()
      Alert.alert('Error', 'Failed to record video. Please try again.')
    } finally {
      if (recordingSessionRef.current === sessionId) {
        isStartingRecordingRef.current = false
      }
    }
  }, [
    clearStopTimeout,
    clearUploadStartTimeout,
    logRecordingError,
    resetRecordingState,
    startSegmentRecording,
    state$,
  ])

  const stopRecording = useCallback(() => {
    const currentState = state$.recordingState.get()

    if (currentState !== 'recording' && currentState !== 'stopping') {
      return
    }

    const sessionId = recordingSessionRef.current

    if (!hasActiveSegmentRef.current) {
      recordingActionRef.current = 'stop'
      state$.recordingState.set('stopping')
      state$.progressStage.set('Finishing recording...')
      clearStopTimeout()
      void finalizeRecording(sessionId)
      return
    }

    if (!cameraRef.current) {
      recordingSessionRef.current += 1
      recordingActionRef.current = 'none'
      hasActiveSegmentRef.current = false
      isStartingRecordingRef.current = false
      resetRecordingState()
      Alert.alert('Camera Not Ready', 'The camera was unavailable, so the recording was reset.')
      return
    }

    recordingActionRef.current = 'stop'
    state$.recordingState.set('stopping')
    state$.progressStage.set('Finishing recording...')
    clearStopTimeout()
    stopTimeoutRef.current = setTimeout(() => {
      if (recordingSessionRef.current === sessionId && state$.recordingState.get() === 'stopping') {
        console.warn('Recording stop timed out; resetting create screen state')
        recordingSessionRef.current += 1
        isStartingRecordingRef.current = false
        resetRecordingState()
        Alert.alert(
          'Recording Stopped',
          'The recording session was reset because it did not finish properly. Please try again.',
        )
      }
    }, 8000)

    try {
      cameraRef.current?.stopRecording()
    } catch (error) {
      clearStopTimeout()
      logRecordingError(error)
      recordingSessionRef.current += 1
      recordingActionRef.current = 'none'
      hasActiveSegmentRef.current = false
      isStartingRecordingRef.current = false
      resetRecordingState()
      Alert.alert('Error', 'Failed to stop recording cleanly. Please try again.')
    }
  }, [clearStopTimeout, finalizeRecording, logRecordingError, resetRecordingState, state$])

  const toggleFacing = useCallback(() => {
    const currentTargetFacing = state$.pendingFacing.get() ?? state$.facing.get()
    const nextFacing = currentTargetFacing === 'back' ? 'front' : 'back'

    if (state$.recordingState.get() === 'recording') {
      state$.pendingFacing.set(nextFacing)

      if (recordingActionRef.current === 'swap' || !hasActiveSegmentRef.current) {
        return
      }

      if (isStartingRecordingRef.current || !cameraRef.current) {
        return
      }

      recordingActionRef.current = 'swap'
      try {
        cameraRef.current.stopRecording()
      } catch (error) {
        clearStopTimeout()
        logRecordingError(error)
        resetRecordingState()
        Alert.alert('Error', 'Failed to switch cameras. Please try again.')
      }
      return
    }

    if (state$.recordingState.get() === 'stopping') {
      return
    }

    state$.pendingFacing.set(null)
    state$.isCameraReady.set(false)
    state$.cameraMountError.set(null)
    state$.facing.set(nextFacing)
  }, [clearStopTimeout, logRecordingError, resetRecordingState, state$])

  const shouldRenderCamera =
    cameraPermission?.granted && micPermission?.granted && isFocused && isAppActive

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
    const canCancelProcessing =
      progressStage !== 'Combining camera segments...' && progressStage !== 'Preparing video...'

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

          {canCancelProcessing && (
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
          )}
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
      {shouldRenderCamera ? (
        <CameraView
          key={cameraResetCounter}
          ref={cameraRef}
          style={{ flex: 1 }}
          facing={facing}
          mode="video"
          onCameraReady={() => {
            state$.isCameraReady.set(true)
            state$.cameraMountError.set(null)

            if (state$.recordingState.get() !== 'recording' || hasActiveSegmentRef.current) {
              return
            }

            const targetFacing = state$.pendingFacing.get()
            const sessionId = recordingSessionRef.current

            if (targetFacing && targetFacing !== state$.facing.get()) {
              state$.isCameraReady.set(false)
              state$.cameraMountError.set(null)
              state$.facing.set(targetFacing)
              return
            }

            if (targetFacing === state$.facing.get()) {
              state$.pendingFacing.set(null)
            }

            if (!isStartingRecordingRef.current) {
              void startSegmentRecording(sessionId)
            }
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

            {recordingState === 'stopping' && (
              <YStack alignItems="center" gap={12}>
                <Spinner size="large" color={bondfireColors.whiteSmoke} />
                <Text color={bondfireColors.whiteSmoke} fontSize={18} fontWeight="700">
                  Finishing recording
                </Text>
                <Text color={bondfireColors.ash} fontSize={14}>
                  Please wait a moment...
                </Text>
              </YStack>
            )}
          </YStack>

          {/* Record button */}
          <YStack paddingBottom={40} alignItems="center">
            <Pressable
              disabled={
                (!isCameraReady && recordingState !== 'recording') || recordingState === 'stopping'
              }
              onPress={() => {
                if (recordingState === 'recording') {
                  stopRecording()
                  return
                }

                if (recordingState === 'idle') {
                  startRecording()
                }
              }}
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
                  recordingState === 'recording' || recordingState === 'stopping'
                    ? bondfireColors.error
                    : 'transparent'
                }
                opacity={
                  !isCameraReady && recordingState !== 'recording'
                    ? 0.5
                    : recordingState === 'stopping'
                      ? 0.7
                      : 1
                }
              >
                {recordingState === 'stopping' ? (
                  <Spinner size="small" color={bondfireColors.whiteSmoke} />
                ) : (
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
                )}
              </YStack>
            </Pressable>

            <Text color={bondfireColors.ash} fontSize={13} marginTop={12}>
              {recordingState === 'stopping'
                ? 'Stopping recording...'
                : recordingState === 'recording'
                  ? 'Tap to stop'
                  : cameraMountError
                    ? 'Camera failed to initialize'
                    : isCameraReady
                      ? 'Tap to record'
                      : 'Initializing camera...'}
            </Text>

            {cameraMountError && recordingState === 'idle' && (
              <Button variant="ghost" size="$sm" marginTop={12} onPress={resetCameraPreview}>
                Retry Camera
              </Button>
            )}
          </YStack>
        </CameraView>
      ) : (
        <YStack flex={1} />
      )}
    </YStack>
  )
}
