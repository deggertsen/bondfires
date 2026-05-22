import {
  appActions,
  appStore$,
  cancelProcessing,
  cleanupTempVideos,
  livePublishActions,
  livePublishStore$,
  resumePendingUploads,
  startBackgroundUpload,
  useLivePublisher,
  useSubscription,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame, SwitchCamera, X } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import {
  type CameraType,
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Alert, AppState, Platform, Pressable, ScrollView, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../../components/CompletionScreen'
import { mergeVideoSegments } from '../../../lib/videoSegmentMerger'
import { BondfireLivePublisher, LivePublisherView } from '../../../modules/bondfire-live-publisher'

type RecordingState = 'idle' | 'recording' | 'stopping' | 'completion' | 'processing' | 'uploading'
type TradeTag = 'need' | 'offer'
type CampWithMembership = Doc<'camps'> & { membership: Doc<'campMembers'> | null }

function formatRecordingClock(seconds: number) {
  const normalizedSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(normalizedSeconds / 60)
  const remainingSeconds = normalizedSeconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function formatMaxDuration(seconds: number) {
  if (seconds % 60 === 0) {
    return `${Math.floor(seconds / 60)} min`
  }

  return formatRecordingClock(seconds)
}

export default function CreateScreen() {
  const router = useRouter()
  const { campId, respondTo } = useLocalSearchParams<{ campId?: string; respondTo?: string }>()
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()

  // Subscription gating for Spark/create actions
  const { canCreate, showPaywall } = useSubscription()

  const cameraRef = useRef<CameraView>(null)
  const isStartingRecordingRef = useRef(false)
  const recordingSessionRef = useRef(0)
  const recordingActionRef = useRef<'none' | 'swap' | 'stop'>('none')
  const hasActiveSegmentRef = useRef(false)
  const recordedSegmentUrisRef = useRef<string[]>([])
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasFocusedRef = useRef(isFocused)
  const didRouteFirstSparkRef = useRef(false)

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
    isLivePublisherAvailable: false,
    cameraMountError: null as string | null,
    selectedCampId: null as Id<'camps'> | null,
    promptCampId: null as Id<'camps'> | null,
    promptDismissed: false,
    tradeTag: null as TradeTag | null,
  })

  const facing = useValue(state$.facing)
  const pendingFacing = useValue(state$.pendingFacing)
  const cameraResetCounter = useValue(state$.cameraResetCounter)
  const recordingState = useValue(state$.recordingState)
  const recordingDuration = useValue(state$.recordingDuration)
  const videoUri = useValue(state$.videoUri)
  const progress = useValue(state$.progress)
  const progressStage = useValue(state$.progressStage)
  const isAppActive = useValue(state$.isAppActive)
  const isCameraReady = useValue(state$.isCameraReady)
  const isLivePublisherAvailable = useValue(state$.isLivePublisherAvailable)
  const cameraMountError = useValue(state$.cameraMountError)
  const selectedCampId = useValue(state$.selectedCampId)
  const promptDismissed = useValue(state$.promptDismissed)
  const tradeTag = useValue(state$.tradeTag)
  const livePublishEnabled = useValue(appStore$.preferences.livePublishEnabled)
  const currentCampId = useValue(appStore$.currentCampId)
  const shouldUseLivePublish = livePublishEnabled && isLivePublisherAvailable
  const liveStatus = useValue(livePublishStore$.status)
  const liveRecordId = useValue(livePublishStore$.recordId)
  const isSwitchingCamera = recordingState === 'recording' && !!pendingFacing

  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const getMuxUploadStatus = useAction(api.videos.getMuxUploadStatus)
  const createLiveStream = useAction(api.videos.createLiveStream)
  const endLiveStream = useAction(api.videos.endLiveStream)
  const cancelLiveStream = useAction(api.videos.cancelLiveStream)
  const camps = useQuery(api.camps.list, respondTo ? 'skip' : {})
  const subscription = useQuery(api.subscriptions.current, {})
  const currentUser = useQuery(api.users.current)
  const joinCamp = useMutation(api.camps.join)
  const persistedCampId = currentCampId as Id<'camps'> | null
  const effectiveCampId = respondTo
    ? undefined
    : ((campId as Id<'camps'> | undefined) ?? selectedCampId ?? persistedCampId ?? undefined)
  const selectedCamp = useMemo(() => {
    if (!effectiveCampId || !camps) return null
    return camps.find((camp) => camp._id === effectiveCampId) ?? null
  }, [camps, effectiveCampId])
  const isResolvingSelectedCamp = !respondTo && !!effectiveCampId && camps === undefined
  const isSelectedCampUnavailable =
    !respondTo && !!effectiveCampId && camps !== undefined && selectedCamp === null
  const sortedCamps = useMemo(() => {
    if (!camps) return []
    const userGender = currentUser?.gender
    return camps
      .filter((camp) => camp.visibility !== 'private' || camp.membership?.role === 'owner')
      .sort((left, right) => {
        const leftWelcome = left.slug.startsWith('welcome-fires') ? -1 : 0
        const rightWelcome = right.slug.startsWith('welcome-fires') ? -1 : 0
        if (leftWelcome !== rightWelcome) return leftWelcome - rightWelcome

        const leftMatch = userGender && left.rules.gender === userGender ? -1 : 0
        const rightMatch = userGender && right.rules.gender === userGender ? -1 : 0
        if (leftMatch !== rightMatch) return leftMatch - rightMatch

        return left.name.localeCompare(right.name)
      })
  }, [camps, currentUser?.gender])
  const selectedCampTags = tradeTag ? [tradeTag] : undefined
  const selectedCampMaxSeconds = selectedCamp?.rules.maxDurationMs
    ? Math.floor(selectedCamp.rules.maxDurationMs / 1000)
    : undefined
  const tierMaxSeconds = subscription?.maxVideoDurationMs
    ? Math.floor(subscription.maxVideoDurationMs / 1000)
    : undefined
  const effectiveMaxRecordingSeconds = useMemo(() => {
    const limits = [selectedCampMaxSeconds, tierMaxSeconds].filter(
      (limit): limit is number => typeof limit === 'number' && limit > 0,
    )
    return limits.length > 0 ? Math.min(...limits) : undefined
  }, [selectedCampMaxSeconds, tierMaxSeconds])
  const recordingTimeRemainingSeconds = effectiveMaxRecordingSeconds
    ? Math.max(0, effectiveMaxRecordingSeconds - recordingDuration)
    : undefined
  const showRecordingLimitCountdown =
    recordingTimeRemainingSeconds !== undefined &&
    recordingTimeRemainingSeconds <= 60 &&
    (recordingState === 'recording' || liveStatus === 'live' || liveStatus === 'reconnecting')
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
  const needsTradeTag =
    !respondTo && selectedCamp?.rules.requiresTradeTags === true && tradeTag === null
  const livePublisher = useLivePublisher({
    publisher: BondfireLivePublisher,
    createLiveStream: async (args) =>
      await createLiveStream({
        ...args,
        bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
        campId: args.campId as Id<'camps'> | undefined,
        tags: args.tags,
      }),
    endLiveStream: async (args) =>
      await endLiveStream({
        ...args,
        liveSessionId: args.liveSessionId as Id<'liveSessions'>,
      }),
    cancelLiveStream: async (args) =>
      await cancelLiveStream({
        ...args,
        liveSessionId: args.liveSessionId as Id<'liveSessions'>,
      }),
  })
  const keepAwakeTag = 'create-recording'

  useEffect(() => {
    if (respondTo || !campId) {
      return
    }

    appActions.setCurrentCampId(campId)
  }, [campId, respondTo])

  useEffect(() => {
    if (respondTo || !persistedCampId || camps === undefined) {
      return
    }

    if (!camps.some((camp) => camp._id === persistedCampId)) {
      appActions.setCurrentCampId(null)
    }
  }, [camps, persistedCampId, respondTo])

  useEffect(() => {
    if (
      respondTo ||
      campId ||
      selectedCampId ||
      persistedCampId ||
      !currentUser ||
      (currentUser.bondfireCount ?? 0) !== 0 ||
      camps === undefined ||
      didRouteFirstSparkRef.current
    ) {
      return
    }

    const gender =
      currentUser.gender === 'female' ? 'women' : currentUser.gender === 'male' ? 'men' : null
    const welcomeCamp =
      (gender ? camps.find((camp) => camp.slug === ['welcome-fires', gender].join('-')) : null) ??
      camps.find(
        (camp) =>
          camp.slug.startsWith('welcome-fires') &&
          (camp.rules.gender === currentUser.gender || camp.rules.gender === 'any'),
      )

    if (!welcomeCamp) {
      return
    }

    didRouteFirstSparkRef.current = true
    joinCamp({ campId: welcomeCamp._id })
      .then((result) => {
        if (result.status === 'pending') {
          return
        }
        state$.selectedCampId.set(welcomeCamp._id)
        state$.tradeTag.set(null)
        appActions.setCurrentCampId(welcomeCamp._id)
      })
      .catch((error) => {
        didRouteFirstSparkRef.current = false
        console.error('Failed to route first spark to Welcome Fires:', error)
      })
  }, [campId, camps, currentUser, joinCamp, persistedCampId, respondTo, selectedCampId, state$])

  useEffect(() => {
    if (respondTo || !effectiveCampId) {
      state$.promptCampId.set(null)
      state$.promptDismissed.set(true)
      return
    }

    if (!selectedCamp) {
      return
    }

    if (state$.promptCampId.get() !== selectedCamp._id) {
      state$.promptCampId.set(effectiveCampId)
      state$.promptDismissed.set(false)
    }

    const timeout = setTimeout(() => {
      if (state$.promptCampId.get() === selectedCamp._id) {
        state$.promptDismissed.set(true)
      }
    }, 3000)

    return () => clearTimeout(timeout)
  }, [effectiveCampId, respondTo, selectedCamp, state$])

  // Recording timer (interval-based - keep useEffect)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined

    if (recordingState === 'recording' || liveStatus === 'live') {
      interval = setInterval(() => {
        state$.recordingDuration.set((prev) => prev + 1)
      }, 1000)
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [recordingState, liveStatus, state$])

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
        recordingState === 'uploading' ||
        liveStatus === 'connecting' ||
        liveStatus === 'live' ||
        liveStatus === 'reconnecting' ||
        liveStatus === 'stopping')

    if (shouldKeepAwake) {
      activateKeepAwakeAsync(keepAwakeTag)
    } else {
      deactivateKeepAwake(keepAwakeTag)
    }

    return () => {
      deactivateKeepAwake(keepAwakeTag)
    }
  }, [recordingState, liveStatus, isFocused, isAppActive])

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

  useEffect(() => {
    let isCancelled = false

    BondfireLivePublisher.isAvailable()
      .then((isAvailable) => {
        if (!isCancelled) {
          state$.isLivePublisherAvailable.set(isAvailable)
        }
      })
      .catch((error) => {
        console.warn('Failed to check live publisher availability:', error)
        if (!isCancelled) {
          state$.isLivePublisherAvailable.set(false)
        }
      })

    return () => {
      isCancelled = true
    }
  }, [state$])

  useEffect(() => {
    if (!shouldUseLivePublish) {
      return
    }

    if (
      (!isFocused || !isAppActive) &&
      (liveStatus === 'connecting' || liveStatus === 'live' || liveStatus === 'reconnecting')
    ) {
      livePublisher.stop().catch((error) => {
        console.error('Failed to stop live stream while screen lost focus:', error)
      })
    }
  }, [isAppActive, isFocused, livePublisher, liveStatus, shouldUseLivePublish])

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
      createMuxDirectUpload: async (args) => {
        return await createMuxDirectUpload({
          ...args,
          bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
          campId: args.campId as Id<'camps'> | undefined,
          tags: args.tags,
        })
      },
      getMuxUploadStatus: async (args) => {
        return await getMuxUploadStatus(args)
      },
    })
  }, [createMuxDirectUpload, getMuxUploadStatus])

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
            campId: effectiveCampId,
            tags: selectedCampTags,
            isResponse: !!respondTo,
            createMuxDirectUpload: async (args) => {
              return await createMuxDirectUpload({
                ...args,
                bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
                campId: args.campId as Id<'camps'> | undefined,
                tags: args.tags,
              })
            },
            getMuxUploadStatus: async (args) => {
              return await getMuxUploadStatus(args)
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
    [effectiveCampId, respondTo, selectedCampTags, createMuxDirectUpload, getMuxUploadStatus],
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

    if (!respondTo && (!effectiveCampId || !selectedCamp)) {
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
    canCreate,
    clearStopTimeout,
    clearUploadStartTimeout,
    effectiveCampId,
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
      if (isStartingRecordingRef.current || !cameraRef.current) {
        return
      }

      state$.pendingFacing.set(nextFacing)

      if (recordingActionRef.current === 'swap' || !hasActiveSegmentRef.current) {
        if (!hasActiveSegmentRef.current && state$.facing.get() !== nextFacing) {
          state$.isCameraReady.set(false)
          state$.cameraMountError.set(null)
          state$.facing.set(nextFacing)
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

  const startLiveRecording = useCallback(async () => {
    if (liveStatus !== 'idle' && liveStatus !== 'ended' && liveStatus !== 'errored') {
      return
    }

    if (!respondTo && (!effectiveCampId || !selectedCamp)) {
      Alert.alert('Choose a Camp', 'Pick where this Bondfire belongs before going live.')
      return
    }

    if (needsTradeTag) {
      Alert.alert('Choose Need or Offer', 'Trading Post sparks need a need or offer tag.')
      return
    }

    if (!state$.isFocused.get() || !state$.isAppActive.get()) {
      Alert.alert('Camera Not Ready', 'Please return to the app and try again.')
      return
    }

    try {
      state$.recordingDuration.set(0)
      state$.videoUri.set(null)
      await livePublisher.start({
        respondToBondfireId: respondTo,
        campId: effectiveCampId,
        tags: selectedCampTags,
        initialCamera: state$.facing.get() === 'back' ? 'back' : 'front',
      })
    } catch (error) {
      logRecordingError(error)
      Alert.alert('Live Stream Failed', 'Could not start the live stream. Please try again.')
    }
  }, [
    effectiveCampId,
    livePublisher,
    liveStatus,
    logRecordingError,
    needsTradeTag,
    respondTo,
    selectedCamp,
    selectedCampTags,
    state$,
  ])

  const handleSelectCamp = useCallback(
    async (camp: CampWithMembership) => {
      try {
        if (camp.membership?.status !== 'active') {
          const result = await joinCamp({ campId: camp._id })
          if (result.status === 'pending') {
            Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
            return
          }
        }

        state$.selectedCampId.set(camp._id)
        state$.tradeTag.set(null)
        appActions.setCurrentCampId(camp._id)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to join camp'
        Alert.alert('Camp Unavailable', message)
      }
    },
    [joinCamp, state$],
  )

  const stopLiveRecording = useCallback(async () => {
    if (liveStatus !== 'connecting' && liveStatus !== 'live' && liveStatus !== 'reconnecting') {
      return
    }

    try {
      await livePublisher.stop()
      state$.recordingState.set('completion')
      state$.videoUri.set('live')
    } catch (error) {
      logRecordingError(error)
      Alert.alert(
        'Live Stream Stopping',
        'The live connection stopped locally, but the saved video may still finish processing.',
      )
      // Roll back local UI state so the user isn't stuck on the live capture
      // screen with a publisher session that's already been torn down.
      livePublishActions.reset()
      state$.recordingState.set('idle')
      state$.videoUri.set(null)
    }
  }, [livePublisher, liveStatus, logRecordingError, state$])

  useEffect(() => {
    if (!effectiveMaxRecordingSeconds || recordingDuration < effectiveMaxRecordingSeconds) {
      return
    }

    if (recordingState === 'recording') {
      stopRecording()
      return
    }

    if (liveStatus === 'live' || liveStatus === 'reconnecting') {
      void stopLiveRecording()
    }
  }, [
    liveStatus,
    recordingDuration,
    recordingState,
    effectiveMaxRecordingSeconds,
    stopLiveRecording,
    stopRecording,
  ])

  const cancelLiveRecording = useCallback(async () => {
    try {
      await livePublisher.cancel()
    } catch (error) {
      logRecordingError(error)
      Alert.alert('Error', 'Failed to cancel the live stream cleanly.')
    } finally {
      // useLivePublisher.cancel already calls livePublishActions.reset() in its
      // own finally, but reset here as well so this code path stays correct
      // even if the hook's behavior changes.
      livePublishActions.reset()
      state$.recordingState.set('idle')
      state$.videoUri.set(null)
    }
  }, [livePublisher, logRecordingError, state$])

  const toggleLiveFacing = useCallback(() => {
    if (liveStatus === 'connecting' || liveStatus === 'live' || liveStatus === 'reconnecting') {
      livePublisher.swapCamera().catch((error) => {
        logRecordingError(error)
        Alert.alert('Error', 'Failed to switch cameras. Please try again.')
      })
      state$.facing.set(state$.facing.get() === 'back' ? 'front' : 'back')
      return
    }

    toggleFacing()
  }, [livePublisher, liveStatus, logRecordingError, state$, toggleFacing])

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

  if (isResolvingSelectedCamp) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        gap={14}
      >
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
        <Text color={bondfireColors.ash}>Loading camp...</Text>
      </YStack>
    )
  }

  if (isSelectedCampUnavailable) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        padding={24}
        gap={16}
      >
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <Text fontSize={24} fontWeight="900" textAlign="center">
          Camp unavailable
        </Text>
        <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
          Choose an active camp before recording.
        </Text>
        <Button
          variant="primary"
          size="$lg"
          onPress={() => {
            state$.selectedCampId.set(null)
            state$.tradeTag.set(null)
            appActions.setCurrentCampId(null)
            router.replace('/(main)/(tabs)/create')
          }}
        >
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            Choose Camp
          </Text>
        </Button>
      </YStack>
    )
  }

  if (!respondTo && !effectiveCampId) {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack paddingTop={64} paddingHorizontal={20} paddingBottom={16} gap={8}>
          <Text fontSize={28} fontWeight="900">
            Choose a Camp
          </Text>
          <Text fontSize={14} color={bondfireColors.ash} lineHeight={20}>
            Every Bondfire starts in a camp.
          </Text>
        </YStack>
        {camps === undefined ? (
          <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
            <Spinner size="large" color={bondfireColors.bondfireCopper} />
            <Text color={bondfireColors.ash}>Loading camps...</Text>
          </YStack>
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
            <YStack gap={10}>
              {sortedCamps.map((camp) => {
                const isActiveMember = camp.membership?.status === 'active'
                const isPending = camp.membership?.status === 'pending'
                return (
                  <Pressable
                    key={camp._id}
                    disabled={isPending}
                    onPress={() => handleSelectCamp(camp)}
                  >
                    <YStack
                      padding={14}
                      borderRadius={16}
                      backgroundColor={bondfireColors.gunmetal}
                      borderWidth={1}
                      borderColor={camp.color ?? bondfireColors.iron}
                      opacity={isPending ? 0.65 : 1}
                      gap={8}
                    >
                      <XStack justifyContent="space-between" alignItems="center" gap={12}>
                        <YStack flex={1} gap={3}>
                          <Text fontSize={17} fontWeight="900" numberOfLines={1}>
                            {camp.name}
                          </Text>
                          <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1}>
                            {camp.theme ?? 'Camp'}
                          </Text>
                        </YStack>
                        <Text
                          fontSize={12}
                          color={isActiveMember ? bondfireColors.success : bondfireColors.ash}
                          fontWeight="900"
                        >
                          {isPending ? 'Pending' : isActiveMember ? 'Joined' : 'Join'}
                        </Text>
                      </XStack>
                      <Text fontSize={14} color={bondfireColors.whiteSmoke} lineHeight={20}>
                        {camp.purpose}
                      </Text>
                    </YStack>
                  </Pressable>
                )
              })}
            </YStack>
          </ScrollView>
        )}
      </YStack>
    )
  }

  if (!respondTo && selectedCamp && !promptDismissed) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        padding={24}
        gap={18}
      >
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack
          width={78}
          height={78}
          borderRadius={22}
          backgroundColor={selectedCamp.color ?? bondfireColors.gunmetal}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={38} color={bondfireColors.whiteSmoke} />
        </YStack>
        <Text fontSize={24} fontWeight="900" textAlign="center">
          {selectedCamp.name}
        </Text>
        <Text fontSize={16} color={bondfireColors.whiteSmoke} textAlign="center" lineHeight={23}>
          {selectedCamp.defaultPrompt ?? selectedCamp.purpose}
        </Text>
        <Button variant="primary" size="$lg" onPress={() => state$.promptDismissed.set(true)}>
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            Continue
          </Text>
        </Button>
      </YStack>
    )
  }

  if (needsTradeTag) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        padding={24}
        justifyContent="center"
        gap={18}
      >
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <Text fontSize={24} fontWeight="900" textAlign="center">
          Need or Offer?
        </Text>
        <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
          Trading Post sparks need a clear tag before recording.
        </Text>
        <XStack gap={12}>
          {(['need', 'offer'] as const).map((tag) => (
            <Button
              key={tag}
              variant="primary"
              size="$lg"
              flex={1}
              onPress={() => state$.tradeTag.set(tag)}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="900" textTransform="capitalize">
                {tag}
              </Text>
            </Button>
          ))}
        </XStack>
      </YStack>
    )
  }

  // Completion screen - shown immediately after recording
  if (recordingState === 'completion' && videoUri) {
    const completionDetail = respondTo
      ? 'Awesome, great video! We are getting your response ready now. It may take up to two minutes to show in activity lists.'
      : 'Awesome, great video! We are getting it ready now. It may take up to two minutes for your video to show in Discover, Recent, and Active.'

    return (
      <CompletionScreen
        detail={completionDetail}
        onContinue={() => {
          const targetBondfireId = respondTo ?? liveRecordId
          livePublishActions.reset()
          if (shouldUseLivePublish && targetBondfireId) {
            router.replace(`/(main)/bondfire/${targetBondfireId}`)
            return
          }
          router.replace('/(main)/(tabs)/feed')
        }}
      />
    )
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

  if (shouldUseLivePublish) {
    const isLiveRecording =
      liveStatus === 'connecting' || liveStatus === 'live' || liveStatus === 'reconnecting'
    const isLiveBusy = liveStatus === 'creating' || liveStatus === 'stopping'
    const statusLabel =
      liveStatus === 'creating'
        ? 'Creating live stream...'
        : liveStatus === 'connecting'
          ? 'Connecting...'
          : liveStatus === 'live'
            ? 'LIVE'
            : liveStatus === 'reconnecting'
              ? 'Reconnecting...'
              : liveStatus === 'stopping'
                ? 'Saving live moment...'
                : 'Tap to go live'

    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        {shouldRenderCamera ? (
          <>
            <LivePublisherView style={{ flex: 1 }} />

            <XStack
              position="absolute"
              top={0}
              left={0}
              right={0}
              paddingTop={60}
              paddingHorizontal={20}
              justifyContent="space-between"
              alignItems="center"
            >
              <Pressable onPress={isLiveRecording ? cancelLiveRecording : () => router.back()}>
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

              {isLiveRecording && (
                <YStack
                  backgroundColor={
                    showRecordingLimitCountdown ? bondfireColors.warningDark : bondfireColors.error
                  }
                  paddingHorizontal={16}
                  paddingVertical={6}
                  borderRadius={16}
                >
                  <Text color={bondfireColors.whiteSmoke} fontWeight="800" fontSize={14}>
                    {liveStatus === 'live' ? `LIVE ${recordingTimerLabel}` : statusLabel}
                  </Text>
                </YStack>
              )}

              <Pressable onPress={toggleLiveFacing} disabled={isLiveBusy}>
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor="rgba(31, 32, 35, 0.7)"
                  alignItems="center"
                  justifyContent="center"
                  opacity={isLiveBusy ? 0.5 : 1}
                >
                  <SwitchCamera size={22} color={bondfireColors.whiteSmoke} />
                </YStack>
              </Pressable>
            </XStack>

            <YStack
              position="absolute"
              left={0}
              right={0}
              top="40%"
              alignItems="center"
              pointerEvents="none"
            >
              {!isLiveRecording && !isLiveBusy && (
                <YStack alignItems="center" gap={12}>
                  <XStack alignItems="center" gap={8}>
                    <Flame size={28} color={bondfireColors.bondfireCopper} />
                    <Text color={bondfireColors.whiteSmoke} fontSize={22} fontWeight="700">
                      {respondTo ? 'Respond Live' : (selectedCamp?.name ?? 'Spark a Bondfire')}
                    </Text>
                  </XStack>
                  <Text color={bondfireColors.ash} fontSize={14}>
                    Tap to start a live broadcast
                  </Text>
                </YStack>
              )}

              {isLiveBusy && (
                <YStack alignItems="center" gap={12}>
                  <Spinner size="large" color={bondfireColors.whiteSmoke} />
                  <Text color={bondfireColors.whiteSmoke} fontSize={18} fontWeight="700">
                    {statusLabel}
                  </Text>
                </YStack>
              )}
            </YStack>

            <YStack position="absolute" left={0} right={0} bottom={40} alignItems="center">
              <Pressable
                disabled={isLiveBusy}
                onPress={() => {
                  if (isLiveRecording) {
                    void stopLiveRecording()
                    return
                  }

                  void startLiveRecording()
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
                  backgroundColor={isLiveRecording ? bondfireColors.error : 'transparent'}
                  opacity={isLiveBusy ? 0.7 : 1}
                >
                  {isLiveBusy ? (
                    <Spinner size="small" color={bondfireColors.whiteSmoke} />
                  ) : (
                    <YStack
                      width={isLiveRecording ? 30 : 60}
                      height={isLiveRecording ? 30 : 60}
                      borderRadius={isLiveRecording ? 6 : 30}
                      backgroundColor={
                        isLiveRecording ? bondfireColors.whiteSmoke : bondfireColors.bondfireCopper
                      }
                    />
                  )}
                </YStack>
              </Pressable>

              <Text color={bondfireColors.ash} fontSize={13} marginTop={12}>
                {isLiveRecording
                  ? showRecordingLimitCountdown && autoStopStatusLabel
                    ? autoStopStatusLabel
                    : 'Tap to stop'
                  : statusLabel}
              </Text>
            </YStack>
          </>
        ) : (
          <YStack flex={1} />
        )}
      </YStack>
    )
  }

  // Camera view
  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      {shouldRenderCamera ? (
        <CameraView
          key={`${cameraResetCounter}-${facing}`}
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
                backgroundColor={
                  showRecordingLimitCountdown ? bondfireColors.warningDark : bondfireColors.error
                }
                paddingHorizontal={16}
                paddingVertical={6}
                borderRadius={16}
              >
                <Text color={bondfireColors.whiteSmoke} fontWeight="700" fontSize={14}>
                  {isSwitchingCamera ? 'Switching...' : recordingTimerLabel}
                </Text>
              </YStack>
            )}

            <Pressable
              onPress={toggleFacing}
              disabled={recordingState === 'stopping' || isSwitchingCamera}
            >
              <YStack
                width={40}
                height={40}
                borderRadius={20}
                backgroundColor="rgba(31, 32, 35, 0.7)"
                alignItems="center"
                justifyContent="center"
                opacity={recordingState === 'stopping' || isSwitchingCamera ? 0.5 : 1}
              >
                {isSwitchingCamera ? (
                  <Spinner size="small" color={bondfireColors.whiteSmoke} />
                ) : (
                  <SwitchCamera size={22} color={bondfireColors.whiteSmoke} />
                )}
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
                    {respondTo ? 'Add Your Response' : (selectedCamp?.name ?? 'Spark a Bondfire')}
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

            {isSwitchingCamera && (
              <YStack alignItems="center" gap={12}>
                <Spinner size="large" color={bondfireColors.whiteSmoke} />
                <Text color={bondfireColors.whiteSmoke} fontSize={18} fontWeight="700">
                  Switching camera
                </Text>
                <Text color={bondfireColors.ash} fontSize={14}>
                  Recording will continue automatically.
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
