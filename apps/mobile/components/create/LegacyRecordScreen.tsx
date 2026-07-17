// ── FROZEN FALLBACK ──────────────────────────────────────────────────────
// Legacy expo-camera segment recording, used only when the native live
// publisher is unavailable (simulator, missing dev build). Do not add
// features here — the live path (LiveRecordScreen) is the product
// direction. Bug fixes only.

import {
  buildErrorReportMailto,
  cancelProcessing,
  cleanupTempVideos,
  getUserFacingErrorMessage,
  parseError,
  recordingActions,
  recordingStore$,
  shouldShowReportIssue,
  startBackgroundUpload,
  telemetry,
  useAppThemeColors,
} from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame, SwitchCamera, X } from '@tamagui/lucide-icons'
import { useAction, useConvex } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { CameraView } from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Linking, Platform, Pressable, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { mergeVideoSegments } from '../../lib/videoSegmentMerger'
import {
  type CampWithMembership,
  formatMaxDuration,
  formatRecordingClock,
  type TradeTag,
} from './shared'

const keepAwakeTag = 'create-recording'

interface LegacyRecordScreenProps {
  respondTo: string | undefined
  isPersonalCamp: boolean
  effectiveCampId: Id<'camps'> | undefined
  selectedCamp: CampWithMembership | null
  selectedCampTags: TradeTag[] | undefined
  effectiveMaxRecordingSeconds: number | undefined
  currentUser: FunctionReturnType<typeof api.users.current> | undefined
  canCreate: boolean
  showPaywall: () => void
  needsTradeTag: boolean
  shouldRenderCamera: boolean
  onBack: () => void
  logRecordingError: (error: unknown) => void
  /** Owned by the create router — the completion screen reads it for routing. */
  personalCreateStartedAtRef: MutableRefObject<number | null>
  /** Owned by the create router alongside the pending-upload scheduling. */
  clearUploadStartTimeout: () => void
  /**
   * Pre-existing draft bondfire to activate (Hearth pre-recording invite flow).
   * When set, the background upload attaches to this row instead of creating
   * a new bondfire on recording completion.
   */
  draftBondfireId?: string
}

export function LegacyRecordScreen({
  respondTo,
  isPersonalCamp,
  effectiveCampId,
  selectedCamp,
  selectedCampTags,
  effectiveMaxRecordingSeconds,
  currentUser,
  canCreate,
  showPaywall,
  needsTradeTag,
  shouldRenderCamera,
  onBack,
  logRecordingError,
  personalCreateStartedAtRef,
  clearUploadStartTimeout,
  draftBondfireId,
}: LegacyRecordScreenProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const isFocused = useIsFocused()

  const cameraRef = useRef<CameraView>(null)
  const isStartingRecordingRef = useRef(false)
  const recordingSessionRef = useRef(0)
  const recordingActionRef = useRef<'none' | 'swap' | 'stop'>('none')
  const hasActiveSegmentRef = useRef(false)
  const recordedSegmentUrisRef = useRef<string[]>([])
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const state$ = useObservable({
    isAppActive: AppState.currentState === 'active',
    isFocused: isFocused,
  })

  const isAppActive = useValue(state$.isAppActive)
  const phase = useValue(recordingStore$.phase)
  const facing = useValue(recordingStore$.facing)
  const pendingFacing = useValue(recordingStore$.pendingFacing)
  const cameraResetCounter = useValue(recordingStore$.cameraResetCounter)
  const isCameraReady = useValue(recordingStore$.isCameraReady)
  const cameraMountError = useValue(recordingStore$.cameraMountError)
  const recordingDuration = useValue(recordingStore$.recordingDuration)
  const progress = useValue(recordingStore$.progress)
  const progressStage = useValue(recordingStore$.progressStage)
  const isSwitchingCamera = phase === 'recording' && !!pendingFacing

  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const getMuxUploadStatus = useAction(api.videos.getMuxUploadStatus)
  const convex = useConvex()

  const recordingTimeRemainingSeconds = effectiveMaxRecordingSeconds
    ? Math.max(0, effectiveMaxRecordingSeconds - recordingDuration)
    : undefined
  // The liveStatus terms of this condition live in LiveRecordScreen.
  const showRecordingLimitCountdown =
    recordingTimeRemainingSeconds !== undefined &&
    recordingTimeRemainingSeconds <= 60 &&
    phase === 'recording'
  const recordingLimitClock =
    recordingTimeRemainingSeconds !== undefined
      ? formatRecordingClock(recordingTimeRemainingSeconds)
      : undefined
  const recordingTimerLabel = showRecordingLimitCountdown
    ? `${recordingLimitClock} left`
    : formatRecordingClock(recordingDuration)
  const autoStopStatusLabel = recordingLimitClock
    ? `Auto-stops in ${recordingLimitClock}`
    : undefined
  const maxRecordingLabel = effectiveMaxRecordingSeconds
    ? `Max ${formatMaxDuration(effectiveMaxRecordingSeconds)}`
    : undefined

  // Recording timer (interval-based - keep useEffect)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined

    if (phase === 'recording') {
      interval = setInterval(() => {
        recordingStore$.recordingDuration.set((prev) => prev + 1)
      }, 1000)
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [phase])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current)
        stopTimeoutRef.current = null
      }
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

  // Keep screen awake while recording or processing. (The liveStatus terms of
  // the original condition live in LiveRecordScreen.)
  useEffect(() => {
    const shouldKeepAwake =
      isFocused &&
      isAppActive &&
      (phase === 'recording' ||
        phase === 'stopping' ||
        phase === 'processing' ||
        phase === 'uploading')

    if (shouldKeepAwake) {
      activateKeepAwakeAsync(keepAwakeTag)
    } else {
      deactivateKeepAwake(keepAwakeTag)
    }

    return () => {
      deactivateKeepAwake(keepAwakeTag)
    }
  }, [phase, isFocused, isAppActive])

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current)
      stopTimeoutRef.current = null
    }
  }, [])

  // Tear down the camera session whenever the screen or app becomes inactive.
  // (The pending-upload scheduling half of the original effect lives in the
  // create router, since uploads are shared between paths.)
  useEffect(() => {
    if (!isFocused || !isAppActive) {
      if (
        recordingStore$.phase.get() === 'recording' ||
        recordingStore$.phase.get() === 'stopping'
      ) {
        try {
          cameraRef.current?.stopRecording()
        } catch (error) {
          telemetry.error('create:stop', 'Failed to stop recording while screen lost focus', {
            error: String(error),
          })
        }
        recordingSessionRef.current += 1
        recordingActionRef.current = 'none'
        hasActiveSegmentRef.current = false
        recordedSegmentUrisRef.current = []
        recordingActions.setPhase('idle', 'screen lost focus during legacy recording')
        recordingStore$.recordingDuration.set(0)
        recordingStore$.videoUri.set(null)
        recordingStore$.progress.set(0)
        recordingStore$.progressStage.set('')
      }

      recordingStore$.isCameraReady.set(false)
      recordingStore$.cameraMountError.set(null)
      cameraRef.current = null
      isStartingRecordingRef.current = false
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current)
        stopTimeoutRef.current = null
      }
    }
  }, [isAppActive, isFocused])

  const resetCameraPreview = useCallback(() => {
    clearStopTimeout()
    isStartingRecordingRef.current = false
    recordingStore$.isCameraReady.set(false)
    recordingStore$.cameraMountError.set(null)
    recordingStore$.cameraResetCounter.set((prev) => prev + 1)
  }, [clearStopTimeout])

  const resetRecordingState = useCallback(() => {
    clearStopTimeout()
    clearUploadStartTimeout()
    recordingActionRef.current = 'none'
    hasActiveSegmentRef.current = false
    recordedSegmentUrisRef.current = []
    // Matches the original field-by-field reset exactly (phase idle +
    // duration/videoUri/progress/progressStage/pendingFacing cleared).
    recordingActions.resetFlow()
  }, [clearStopTimeout, clearUploadStartTimeout])

  const queueBackgroundUpload = useCallback(
    async (uri: string) => {
      try {
        // Validate camp context before starting the upload so users get
        // immediate feedback instead of waiting for the upload to fail.
        if (respondTo) {
          const result = await convex.query(api.videos.validateRespondCamp, {
            bondfireId: respondTo as Id<'bondfires'>,
          })
          if (!result.valid) {
            Alert.alert('Cannot Respond', result.error ?? 'You cannot respond to this Bondfire')
            return null
          }
        } else if (isPersonalCamp) {
          const result = await convex.query(api.videos.validatePersonalCreate, {})
          if (!result.valid) {
            Alert.alert('Cannot Spark', result.error ?? 'You cannot create a Personal Bondfire')
            return null
          }
        } else if (effectiveCampId) {
          const result = await convex.query(api.videos.validateCreateCamp, {
            campId: effectiveCampId,
            tags: selectedCampTags,
          })
          if (!result.valid) {
            Alert.alert('Cannot Spark', result.error ?? 'You cannot spark in this camp')
            return null
          }
        }

        if (isPersonalCamp) {
          personalCreateStartedAtRef.current = Date.now()
        }

        return await startBackgroundUpload(
          {
            videoUri: uri,
            bondfireId: respondTo,
            campId: effectiveCampId,
            personalCamp: isPersonalCamp || undefined,
            tags: selectedCampTags,
            isResponse: !!respondTo,
            draftBondfireId: isPersonalCamp ? draftBondfireId : undefined,
            createMuxDirectUpload: async (args) => {
              return await createMuxDirectUpload({
                ...args,
                bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
                campId: args.campId as Id<'camps'> | undefined,
                personalCamp: args.personalCamp,
                tags: args.tags,
                draftBondfireId: args.draftBondfireId as Id<'bondfires'> | undefined,
              })
            },
            getMuxUploadStatus: async (args) => {
              return await getMuxUploadStatus(args)
            },
          },
          false,
        )
      } catch (error) {
        telemetry.error('upload:queue', 'Failed to queue upload', { error: String(error) })
        const errorInfo = parseError(error)
        Alert.alert(
          errorInfo.isNetworkError ? 'No internet connection' : 'Upload Failed',
          getUserFacingErrorMessage(errorInfo),
          shouldShowReportIssue(errorInfo)
            ? [
                { text: 'OK', style: 'default' },
                {
                  text: 'Report Issue',
                  onPress: () => {
                    const url = buildErrorReportMailto({
                      error,
                      userId: currentUser?._id,
                      context: 'Starting upload',
                    })
                    Linking.openURL(url).catch(() => {})
                  },
                },
              ]
            : [{ text: 'OK', style: 'default' }],
        )
        return null
      }
    },
    [
      effectiveCampId,
      respondTo,
      selectedCampTags,
      createMuxDirectUpload,
      getMuxUploadStatus,
      currentUser?._id,
      convex,
      isPersonalCamp,
      personalCreateStartedAtRef,
      draftBondfireId,
    ],
  )

  const finalizeRecording = useCallback(
    async (sessionId: number) => {
      const segmentUris = [...recordedSegmentUrisRef.current]

      if (segmentUris.length === 0) {
        resetRecordingState()
        Alert.alert('Recording Failed', 'No video was captured. Please try again.')
        return
      }

      recordingStore$.pendingFacing.set(null)
      recordingActions.setPhase('processing', 'legacy finalize started')
      recordingStore$.progress.set(0)
      recordingStore$.progressStage.set(
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

        recordingStore$.videoUri.set(finalVideoUri)
        recordingActions.setPhase('completion', 'legacy finalize succeeded')
        const uploadTaskId = await queueBackgroundUpload(finalVideoUri)

        if (uploadTaskId) {
          await cleanupTempVideos(
            finalVideoUri === segmentUris[0] ? segmentUris : [...segmentUris, finalVideoUri],
          )
        }
      } catch (error) {
        logRecordingError(error)
        resetRecordingState()
        const errorInfo = parseError(error)
        Alert.alert(
          errorInfo.isNetworkError ? 'No internet connection' : 'Upload Failed',
          getUserFacingErrorMessage(errorInfo),
        )
      }
    },
    [logRecordingError, queueBackgroundUpload, resetRecordingState],
  )

  const startSegmentRecording = useCallback(
    async (sessionId: number) => {
      const activeCamera = cameraRef.current

      if (!activeCamera || !recordingStore$.isCameraReady.get()) {
        resetRecordingState()
        Alert.alert('Camera Not Ready', 'Please wait a moment and try again.')
        return
      }

      if (
        recordingSessionRef.current !== sessionId ||
        (recordingStore$.phase.get() !== 'recording' && recordingStore$.phase.get() !== 'stopping')
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
          const targetFacing = recordingStore$.pendingFacing.get()
          recordingActionRef.current = 'none'

          if (targetFacing && targetFacing !== recordingStore$.facing.get()) {
            recordingStore$.isCameraReady.set(false)
            recordingStore$.cameraMountError.set(null)
            recordingStore$.facing.set(targetFacing)
            return
          }

          recordingStore$.pendingFacing.set(null)
          void startSegmentRecording(sessionId)
          return
        }

        if (recordingActionRef.current === 'stop' || recordingStore$.phase.get() === 'stopping') {
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
        const errorInfo = parseError(error)
        Alert.alert(
          errorInfo.isNetworkError ? 'No internet connection' : 'Recording Failed',
          getUserFacingErrorMessage(errorInfo),
        )
      } finally {
        if (recordingSessionRef.current === sessionId) {
          isStartingRecordingRef.current = false
        }
      }
    },
    [clearStopTimeout, finalizeRecording, logRecordingError, resetRecordingState],
  )

  const startRecording = useCallback(async () => {
    const activeCamera = cameraRef.current

    // Gate: Free users cannot create bondfires
    if (!respondTo && !canCreate) {
      Alert.alert(
        'Upgrade to Create',
        'Free accounts can browse and watch, but creating bondfires requires a Plus subscription or higher.',
        [
          { text: 'Not Now', style: 'cancel' },
          {
            text: 'View Plans',
            onPress: () => {
              showPaywall()
            },
          },
        ],
      )
      return
    }

    if (!respondTo && !isPersonalCamp && (!effectiveCampId || !selectedCamp)) {
      Alert.alert('Choose a Camp', 'Pick where this Bondfire belongs before recording.')
      return
    }

    if (needsTradeTag) {
      Alert.alert('Choose Need or Offer', 'Trading Post sparks need a need or offer tag.')
      return
    }

    if (!activeCamera) {
      Alert.alert('Camera Not Ready', 'Please wait a moment and try again.')
      return
    }

    // Prevent double-taps / re-entrancy before React has re-rendered with the new state.
    const currentRecordingState = recordingStore$.phase.get()

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
    if (!recordingStore$.isCameraReady.get()) {
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
    recordingActions.setPhase('recording', 'legacy record tap')
    recordingStore$.recordingDuration.set(0)
    recordingStore$.videoUri.set(null)
    recordingStore$.progress.set(0)
    recordingStore$.progressStage.set('')
    recordingStore$.pendingFacing.set(null)

    try {
      await startSegmentRecording(sessionId)
    } catch (error) {
      if (recordingSessionRef.current !== sessionId) {
        return
      }

      clearStopTimeout()
      logRecordingError(error)
      resetRecordingState()
      const errorInfo = parseError(error)
      Alert.alert('Recording Failed', getUserFacingErrorMessage(errorInfo))
    } finally {
      if (recordingSessionRef.current === sessionId) {
        isStartingRecordingRef.current = false
      }
    }
  }, [
    canCreate,
    clearStopTimeout,
    clearUploadStartTimeout,
    effectiveCampId,
    isPersonalCamp,
    logRecordingError,
    needsTradeTag,
    respondTo,
    resetRecordingState,
    selectedCamp,
    showPaywall,
    startSegmentRecording,
    state$,
  ])

  const stopRecording = useCallback(() => {
    const currentState = recordingStore$.phase.get()

    if (currentState !== 'recording' && currentState !== 'stopping') {
      return
    }

    const sessionId = recordingSessionRef.current

    if (!hasActiveSegmentRef.current) {
      recordingActionRef.current = 'stop'
      recordingActions.setPhase('stopping', 'legacy stop tap (no active segment)')
      recordingStore$.progressStage.set('Finishing recording...')
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
    recordingActions.setPhase('stopping', 'legacy stop tap')
    recordingStore$.progressStage.set('Finishing recording...')
    clearStopTimeout()
    stopTimeoutRef.current = setTimeout(() => {
      if (recordingSessionRef.current === sessionId && recordingStore$.phase.get() === 'stopping') {
        telemetry.warn('create:timeout', 'Recording stop timed out; resetting create screen state')
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
      const errorInfo = parseError(error)
      Alert.alert('Recording Stopped', getUserFacingErrorMessage(errorInfo))
    }
  }, [clearStopTimeout, finalizeRecording, logRecordingError, resetRecordingState])

  const toggleFacing = useCallback(() => {
    const currentTargetFacing = recordingStore$.pendingFacing.get() ?? recordingStore$.facing.get()
    const nextFacing = currentTargetFacing === 'back' ? 'front' : 'back'

    if (recordingStore$.phase.get() === 'recording') {
      if (isStartingRecordingRef.current || !cameraRef.current) {
        return
      }

      recordingStore$.pendingFacing.set(nextFacing)

      if (recordingActionRef.current === 'swap' || !hasActiveSegmentRef.current) {
        if (!hasActiveSegmentRef.current && recordingStore$.facing.get() !== nextFacing) {
          recordingStore$.isCameraReady.set(false)
          recordingStore$.cameraMountError.set(null)
          recordingStore$.facing.set(nextFacing)
        }
        return
      }

      recordingActionRef.current = 'swap'
      try {
        cameraRef.current.stopRecording()
      } catch (error) {
        clearStopTimeout()
        logRecordingError(error)
        resetRecordingState()
        const errorInfo = parseError(error)
        Alert.alert('Switch Camera Failed', getUserFacingErrorMessage(errorInfo))
      }
      return
    }

    if (recordingStore$.phase.get() === 'stopping') {
      return
    }

    recordingStore$.pendingFacing.set(null)
    recordingStore$.isCameraReady.set(false)
    recordingStore$.cameraMountError.set(null)
    recordingStore$.facing.set(nextFacing)
  }, [clearStopTimeout, logRecordingError, resetRecordingState])

  // Auto-stop at the recording duration cap. (The live half of the original
  // effect lives in LiveRecordScreen.)
  useEffect(() => {
    if (!effectiveMaxRecordingSeconds || recordingDuration < effectiveMaxRecordingSeconds) {
      return
    }

    if (phase === 'recording') {
      stopRecording()
    }
  }, [recordingDuration, phase, effectiveMaxRecordingSeconds, stopRecording])

  // Processing state
  if (phase === 'processing') {
    const canCancelProcessing =
      progressStage !== 'Combining camera segments...' && progressStage !== 'Preparing video...'

    return (
      <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack alignItems="center" gap={20}>
          <Spinner size="large" color={'$primary'} />
          <Text fontSize={20} fontWeight="600">
            Processing Video
          </Text>
          <Text color={'$placeholderColor'} fontSize={14}>
            {progressStage}
          </Text>
          <YStack width={200} height={6} backgroundColor={'$borderColor'} borderRadius={3}>
            <YStack
              height={6}
              backgroundColor={'$primary'}
              borderRadius={3}
              width={`${progress}%`}
            />
          </YStack>
          <Text color={'$placeholderColor'}>{Math.round(progress)}%</Text>

          {canCancelProcessing && (
            <Button
              variant="ghost"
              size="$sm"
              marginTop={16}
              onPress={() => {
                cancelProcessing()
                recordingActions.setPhase('idle', 'user cancelled processing')
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
  if (phase === 'uploading') {
    return (
      <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack alignItems="center" gap={20}>
          <Spinner size="large" color={'$success'} />
          <Text fontSize={20} fontWeight="600">
            Uploading
          </Text>
          <Text color={'$placeholderColor'} fontSize={14}>
            {progressStage}
          </Text>
          <YStack width={200} height={6} backgroundColor={'$borderColor'} borderRadius={3}>
            <YStack
              height={6}
              backgroundColor={'$success'}
              borderRadius={3}
              width={`${progress}%`}
            />
          </YStack>
          <Text color={'$placeholderColor'}>{Math.round(progress)}%</Text>
        </YStack>
      </YStack>
    )
  }

  // Camera view
  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
      {shouldRenderCamera ? (
        <>
          <CameraView
            key={`${cameraResetCounter}-${facing}`}
            ref={cameraRef}
            style={{ flex: 1 }}
            facing={facing}
            mode="video"
            onCameraReady={() => {
              recordingStore$.isCameraReady.set(true)
              recordingStore$.cameraMountError.set(null)

              if (recordingStore$.phase.get() !== 'recording' || hasActiveSegmentRef.current) {
                return
              }

              const targetFacing = recordingStore$.pendingFacing.get()
              const sessionId = recordingSessionRef.current

              if (targetFacing && targetFacing !== recordingStore$.facing.get()) {
                recordingStore$.isCameraReady.set(false)
                recordingStore$.cameraMountError.set(null)
                recordingStore$.facing.set(targetFacing)
                return
              }

              if (targetFacing === recordingStore$.facing.get()) {
                recordingStore$.pendingFacing.set(null)
              }

              if (!isStartingRecordingRef.current) {
                void startSegmentRecording(sessionId)
              }
            }}
            onMountError={(event) => {
              const message = event?.message ?? 'Unknown camera mount error'
              recordingStore$.cameraMountError.set(message)
              recordingStore$.isCameraReady.set(false)
              telemetry.error('create:camera', 'Camera mount error', {
                platform: Platform.OS,
                message,
              })
              Alert.alert('Camera Error', message)
            }}
          />

          {/* Overlay UI — CameraView does not support children */}
          <YStack
            position="absolute"
            top={0}
            left={0}
            right={0}
            bottom={0}
            pointerEvents="box-none"
          >
            {/* Header */}
            <XStack
              paddingTop={60}
              paddingHorizontal={20}
              justifyContent="space-between"
              alignItems="center"
            >
              <Pressable onPress={onBack}>
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor="rgba(31, 32, 35, 0.7)"
                  alignItems="center"
                  justifyContent="center"
                >
                  <X size={24} color={'$color'} />
                </YStack>
              </Pressable>

              {phase === 'recording' && (
                <YStack
                  backgroundColor={showRecordingLimitCountdown ? '$warning' : '$error'}
                  paddingHorizontal={16}
                  paddingVertical={6}
                  borderRadius={16}
                >
                  <Text color={'$color'} fontWeight="700" fontSize={14}>
                    {isSwitchingCamera ? 'Switching...' : recordingTimerLabel}
                  </Text>
                </YStack>
              )}

              <Pressable
                onPress={toggleFacing}
                disabled={phase === 'stopping' || isSwitchingCamera}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor="rgba(31, 32, 35, 0.7)"
                  alignItems="center"
                  justifyContent="center"
                  opacity={phase === 'stopping' || isSwitchingCamera ? 0.5 : 1}
                >
                  {isSwitchingCamera ? (
                    <Spinner size="small" color={'$color'} />
                  ) : (
                    <SwitchCamera size={22} color={'$color'} />
                  )}
                </YStack>
              </Pressable>
            </XStack>

            {/* Title */}
            <YStack flex={1} justifyContent="center" alignItems="center">
              {phase === 'idle' && (
                <YStack alignItems="center" gap={12}>
                  <XStack alignItems="center" gap={8}>
                    <Flame size={28} color={'$primary'} />
                    <Text color={'$color'} fontSize={22} fontWeight="700">
                      {respondTo ? 'Add Your Response' : (selectedCamp?.name ?? 'Spark a Bondfire')}
                    </Text>
                  </XStack>
                  <Text color={'$placeholderColor'} fontSize={14}>
                    Tap to start recording
                  </Text>
                </YStack>
              )}

              {phase === 'stopping' && (
                <YStack alignItems="center" gap={12}>
                  <Spinner size="large" color={'$color'} />
                  <Text color={'$color'} fontSize={18} fontWeight="700">
                    Finishing recording
                  </Text>
                  <Text color={'$placeholderColor'} fontSize={14}>
                    Please wait a moment...
                  </Text>
                </YStack>
              )}

              {isSwitchingCamera && (
                <YStack alignItems="center" gap={12}>
                  <Spinner size="large" color={'$color'} />
                  <Text color={'$color'} fontSize={18} fontWeight="700">
                    Switching camera
                  </Text>
                  <Text color={'$placeholderColor'} fontSize={14}>
                    Recording will continue automatically.
                  </Text>
                </YStack>
              )}
            </YStack>

            {/* Record button */}
            <YStack paddingBottom={40} alignItems="center">
              <Pressable
                disabled={(!isCameraReady && phase !== 'recording') || phase === 'stopping'}
                onPress={() => {
                  if (phase === 'recording') {
                    stopRecording()
                    return
                  }

                  if (phase === 'idle') {
                    startRecording()
                  }
                }}
              >
                <YStack
                  width={80}
                  height={80}
                  borderRadius={40}
                  borderWidth={4}
                  borderColor={'$color'}
                  alignItems="center"
                  justifyContent="center"
                  backgroundColor={
                    phase === 'recording' || phase === 'stopping' ? '$error' : 'transparent'
                  }
                  opacity={
                    !isCameraReady && phase !== 'recording' ? 0.5 : phase === 'stopping' ? 0.7 : 1
                  }
                >
                  {phase === 'stopping' ? (
                    <Spinner size="small" color={'$color'} />
                  ) : (
                    <YStack
                      width={phase === 'recording' ? 30 : 60}
                      height={phase === 'recording' ? 30 : 60}
                      borderRadius={phase === 'recording' ? 6 : 30}
                      backgroundColor={phase === 'recording' ? '$color' : '$primary'}
                    />
                  )}
                </YStack>
              </Pressable>

              <Text color={'$placeholderColor'} fontSize={13} marginTop={12}>
                {phase === 'stopping'
                  ? 'Stopping recording...'
                  : phase === 'recording'
                    ? isSwitchingCamera
                      ? 'Switching cameras...'
                      : showRecordingLimitCountdown && autoStopStatusLabel
                        ? autoStopStatusLabel
                        : 'Tap to stop'
                    : maxRecordingLabel
                      ? maxRecordingLabel
                      : cameraMountError
                        ? 'Camera failed to initialize'
                        : isCameraReady
                          ? 'Tap to record'
                          : 'Initializing camera...'}
              </Text>

              {cameraMountError && phase === 'idle' && (
                <Button variant="ghost" size="$sm" marginTop={12} onPress={resetCameraPreview}>
                  Retry Camera
                </Button>
              )}
            </YStack>
          </YStack>
        </>
      ) : (
        <YStack flex={1} />
      )}
    </YStack>
  )
}
