import {
  appActions,
  appStore$,
  buildErrorReportMailto,
  cancelProcessing,
  cleanupTempVideos,
  getUserFacingErrorMessage,
  livePublishActions,
  livePublishStore$,
  parseError,
  resumePendingUploads,
  shouldShowReportIssue,
  startBackgroundUpload,
  telemetry,
  useAppThemeColors,
  useLivePublisher,
  useSubscription,
} from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame, Sparkles, SwitchCamera, X } from '@tamagui/lucide-icons'
import { useAction, useConvex, useMutation, useQuery } from 'convex/react'
import {
  type CameraType,
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, Linking, Platform, Pressable, ScrollView, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../../components/CompletionScreen'
import { InviteSheet } from '../../../components/InviteSheet'
import { SparkTitleSheet } from '../../../components/SparkTitleSheet'
import { goBackOrReplace } from '../../../lib/navigation'
import { routes } from '../../../lib/routes'
import { mergeVideoSegments } from '../../../lib/videoSegmentMerger'
import { BondfireLivePublisher, LivePublisherView } from '../../../modules/bondfire-live-publisher'

type RecordingState =
  | 'idle'
  | 'pre_connected'
  | 'recording'
  | 'stopping'
  | 'completion'
  | 'processing'
  | 'uploading'
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
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const { campId, respondTo, personalCamp, title } = useLocalSearchParams<{
    campId?: string
    respondTo?: string
    personalCamp?: string
    title?: string
  }>()
  const isPersonalCamp = personalCamp === '1'
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
  const personalCreateStartedAtRef = useRef<number | null>(null)
  const backgroundCancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preConnectInFlightRef = useRef(false)

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
    showInviteSheet: false,
    preConnectFailed: false,
    previewExpired: false,
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
  const showInviteSheet = useValue(state$.showInviteSheet)
  const preConnectFailed = useValue(state$.preConnectFailed)
  const previewExpired = useValue(state$.previewExpired)
  const livePublishEnabled = useValue(appStore$.preferences.livePublishEnabled)
  const currentCampId = useValue(appStore$.currentCampId)
  const shouldUseLivePublish = livePublishEnabled && isLivePublisherAvailable
  const liveStatus = useValue(livePublishStore$.status)
  const liveRecordId = useValue(livePublishStore$.recordId)
  const isSwitchingCamera = recordingState === 'recording' && !!pendingFacing

  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const getMuxUploadStatus = useAction(api.videos.getMuxUploadStatus)
  const convex = useConvex()
  const createLiveStream = useAction(api.videos.createLiveStream)
  const endLiveStream = useAction(api.videos.endLiveStream)
  const cancelLiveStream = useAction(api.videos.cancelLiveStream)
  const markBondfireLive = useMutation(api.videos.markBondfireLive)
  const touchLiveSession = useMutation(api.videos.touchLiveSession)
  const camps = useQuery(api.camps.list, respondTo ? 'skip' : {})
  const subscription = useQuery(api.subscriptions.current, {})
  const currentUser = useQuery(api.users.current)
  const personalCampDoc = useQuery(api.personalCamps.getMyPersonalCamp, {})
  const joinCamp = useMutation(api.camps.join)
  const persistedCampId = currentCampId as Id<'camps'> | null
  const effectiveCampId = respondTo
    ? undefined
    : isPersonalCamp
      ? undefined
      : ((campId as Id<'camps'> | undefined) ?? selectedCampId ?? persistedCampId ?? undefined)
  const selectedCamp = useMemo(() => {
    if (!effectiveCampId || !camps) return null
    return camps.find((camp) => camp._id === effectiveCampId) ?? null
  }, [camps, effectiveCampId])
  const isResolvingSelectedCamp = !respondTo && !!effectiveCampId && camps === undefined
  const isSelectedCampUnavailable =
    !respondTo && !!effectiveCampId && camps !== undefined && selectedCamp === null
  const [sparkTitleSheetCamp, setSparkTitleSheetCamp] = useState<CampWithMembership | null>(null)
  const sortedCamps = useMemo(() => {
    if (!camps) return []
    const userGender = currentUser?.gender
    return camps
      .filter((camp) => camp.access !== 'invite' || camp.membership?.role === 'owner')
      .sort((left, right) => {
        const leftWelcome = left.slug.startsWith('welcome-fires') ? -1 : 0
        const rightWelcome = right.slug.startsWith('welcome-fires') ? -1 : 0
        if (leftWelcome !== rightWelcome) return leftWelcome - rightWelcome

        const leftMatch = userGender && left.rules.access.gender?.value === userGender ? -1 : 0
        const rightMatch = userGender && right.rules.access.gender?.value === userGender ? -1 : 0
        if (leftMatch !== rightMatch) return leftMatch - rightMatch

        return left.name.localeCompare(right.name)
      })
  }, [camps, currentUser?.gender])
  const selectedCampTags = tradeTag ? [tradeTag] : undefined
  const selectedCampMaxSeconds = selectedCamp?.rules.participation.maxDurationMs
    ? Math.floor(selectedCamp.rules.participation.maxDurationMs / 1000)
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
    !respondTo && selectedCamp?.rules.advisory.requiresTradeTags === true && tradeTag === null
  const livePublisher = useLivePublisher({
    publisher: BondfireLivePublisher,
    createLiveStream: async (args) =>
      await createLiveStream({
        ...args,
        bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
        campId: args.campId as Id<'camps'> | undefined,
        tags: args.tags,
        title: args.title,
        pending: args.pending,
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
          (camp.rules.access.gender?.value === currentUser.gender ||
            camp.rules.access.gender?.value === 'any'),
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
        telemetry.error('create:route', 'Failed to route first spark to Welcome Fires', {
          error: String(error),
        })
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
      if (backgroundCancelTimeoutRef.current) {
        clearTimeout(backgroundCancelTimeoutRef.current)
        backgroundCancelTimeoutRef.current = null
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
        router.replace(routes.create)
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

  // Track camera permission state changes for live path
  useEffect(() => {
    if (cameraPermission?.status) {
      telemetry.info('live:camera_permission', 'Camera permission state', {
        status: cameraPermission.status,
        granted: cameraPermission.granted,
        canAskAgain: cameraPermission.canAskAgain,
      })
    }
  }, [cameraPermission?.status, cameraPermission?.granted, cameraPermission?.canAskAgain])

  useEffect(() => {
    let isCancelled = false

    BondfireLivePublisher.isAvailable()
      .then((isAvailable) => {
        telemetry.info('live:availability', 'Live publisher availability check', {
          available: isAvailable,
          cameraPermission: cameraPermission?.status,
          micPermission: micPermission?.status,
        })
        if (!isCancelled) {
          state$.isLivePublisherAvailable.set(isAvailable)
        }
        // Also report camera count for telemetry
        return BondfireLivePublisher.getCameraCount()
      })
      .then((cameraCount) => {
        if (cameraCount !== undefined) {
          telemetry.info('live:camera_list', 'Available cameras on device', {
            cameraCount,
          })
        }
      })
      .catch((error) => {
        telemetry.warn('live:availability', 'Failed to check live publisher availability', {
          error: String(error),
          cameraPermission: cameraPermission?.status,
        })
        if (!isCancelled) {
          state$.isLivePublisherAvailable.set(false)
        }
      })

    return () => {
      isCancelled = true
    }
    // Include permission status deps so telemetry reflects latest state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state$, cameraPermission?.status, micPermission?.status])

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

      telemetry.error('create:recording', 'Recording error', {
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
          personalCamp: args.personalCamp,
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
        telemetry.error('upload:start', 'Failed to start pending uploads', { error: String(error) })
      })
    }, 1500)
  }, [clearUploadStartTimeout, startPendingUploads, state$])

  // Tear down the camera session whenever the screen or app becomes inactive.
  useEffect(() => {
    if (shouldUseLivePublish) {
      return
    }

    if (!isFocused || !isAppActive) {
      if (
        state$.recordingState.get() === 'recording' ||
        state$.recordingState.get() === 'stopping'
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
  }, [
    clearUploadStartTimeout,
    isAppActive,
    isFocused,
    schedulePendingUploads,
    shouldUseLivePublish,
    state$,
  ])

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
            createMuxDirectUpload: async (args) => {
              return await createMuxDirectUpload({
                ...args,
                bondfireId: args.bondfireId as Id<'bondfires'> | undefined,
                campId: args.campId as Id<'camps'> | undefined,
                personalCamp: args.personalCamp,
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
        const errorInfo = parseError(error)
        Alert.alert(
          errorInfo.isNetworkError ? 'No internet connection' : 'Upload Failed',
          getUserFacingErrorMessage(errorInfo),
        )
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
        const errorInfo = parseError(error)
        Alert.alert('Switch Camera Failed', getUserFacingErrorMessage(errorInfo))
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

  const startLivePreConnect = useCallback(async () => {
    const currentStatus = livePublishStore$.status.get()
    const currentRecordingState = state$.recordingState.get()
    if (
      preConnectInFlightRef.current ||
      currentRecordingState !== 'idle' ||
      (currentStatus !== 'idle' && currentStatus !== 'ended' && currentStatus !== 'errored')
    ) {
      return
    }

    // Guard failures are surfaced through preConnectBlockReason in the UI.
    if (!respondTo && !canCreate) {
      return
    }

    if (!respondTo && !isPersonalCamp && (!effectiveCampId || !selectedCamp)) {
      return
    }

    if (needsTradeTag || !state$.isFocused.get() || !state$.isAppActive.get()) {
      return
    }

    preConnectInFlightRef.current = true
    try {
      state$.preConnectFailed.set(false)
      state$.previewExpired.set(false)
      state$.recordingDuration.set(0)
      state$.videoUri.set(null)
      state$.progressStage.set('Preparing camera...')
      if (isPersonalCamp) {
        personalCreateStartedAtRef.current = Date.now()
      }

      // Camera preview only — nothing is published or recorded until the
      // user taps record and the RTMP connection opens.
      await livePublisher.preview({
        initialCamera: state$.facing.get() === 'back' ? 'back' : 'front',
      })

      if (!respondTo) {
        // Provision the live stream + pending bondfire so the share link
        // works while waiting, but defer publishing to the record tap.
        await livePublisher.provision({
          campId: effectiveCampId,
          personalCamp: isPersonalCamp || undefined,
          tags: selectedCampTags,
          title: title || undefined,
          pending: true,
        })
      }

      state$.recordingState.set('pre_connected')
      state$.showInviteSheet.set(false)
    } catch (error) {
      logRecordingError(error)
      livePublishActions.reset()
      state$.recordingState.set('idle')
      state$.preConnectFailed.set(true)
      state$.showInviteSheet.set(false)
      const errorInfo = parseError(error)
      Alert.alert(
        errorInfo.isNetworkError ? 'No internet connection' : 'Recording Failed',
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
                    context: 'Starting recording',
                  })
                  Linking.openURL(url).catch(() => {})
                },
              },
            ]
          : [{ text: 'OK', style: 'default' }],
      )
    } finally {
      preConnectInFlightRef.current = false
    }
  }, [
    canCreate,
    currentUser?._id,
    effectiveCampId,
    isPersonalCamp,
    livePublisher,
    logRecordingError,
    needsTradeTag,
    respondTo,
    selectedCamp,
    selectedCampTags,
    state$,
    title,
  ])

  const startLiveRecording = useCallback(async () => {
    if (state$.recordingState.get() !== 'pre_connected') {
      return
    }

    const currentStatus = livePublishStore$.status.get()
    if (
      currentStatus === 'connecting' ||
      currentStatus === 'live' ||
      currentStatus === 'reconnecting'
    ) {
      return
    }

    if (!state$.isFocused.get() || !state$.isAppActive.get()) {
      Alert.alert('Camera Not Ready', 'Please return to the app and try again.')
      return
    }

    const initialCamera = state$.facing.get() === 'back' ? ('back' as const) : ('front' as const)

    try {
      if (respondTo) {
        // Responses provision + connect at tap so the response is never
        // visible to viewers before recording actually starts.
        await livePublisher.start({
          respondToBondfireId: respondTo,
          tags: selectedCampTags,
          initialCamera,
        })
      } else {
        // Recording starts the moment the RTMP connection opens.
        await livePublisher.connect({ initialCamera })
      }
    } catch (error) {
      logRecordingError(error)
      Alert.alert('Recording Failed', getUserFacingErrorMessage(parseError(error)))
      return
    }

    if (!respondTo) {
      const recordId = livePublishStore$.recordId.get()
      if (recordId) {
        try {
          await markBondfireLive({ bondfireId: recordId as Id<'bondfires'> })
        } catch (error) {
          // Keep recording — the VOD pipeline still completes via webhooks;
          // viewers just won't see the live state for this bondfire.
          logRecordingError(error)
        }
      }
    }

    state$.showInviteSheet.set(false)
    state$.recordingDuration.set(0)
    state$.recordingState.set('recording')
  }, [livePublisher, logRecordingError, markBondfireLive, respondTo, selectedCampTags, state$])

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

        // Show the title sheet before proceeding to the camp prompt
        setSparkTitleSheetCamp(camp)
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Camp Unavailable', message)
      }
    },
    [joinCamp],
  )

  const handleSparkTitleSubmit = useCallback(
    (sparkTitle: string) => {
      const camp = sparkTitleSheetCamp
      setSparkTitleSheetCamp(null)
      if (!camp) return
      state$.selectedCampId.set(camp._id)
      state$.tradeTag.set(null)
      appActions.setCurrentCampId(camp._id)
      // Navigate with title param so it flows through the recording pipeline
      router.replace(routes.createForCamp(camp._id, sparkTitle || undefined))
    },
    [router, sparkTitleSheetCamp, state$],
  )

  const handleOpenPersonalHearth = useCallback(() => {
    router.replace(routes.createForPersonalCamp())
  }, [router])

  const stopLiveRecording = useCallback(async () => {
    const currentRecordingState = state$.recordingState.get()
    const isConnectionActive =
      liveStatus === 'connecting' || liveStatus === 'live' || liveStatus === 'reconnecting'
    // Also allow stopping when the connection errored mid-recording so the
    // partial recording is finalized instead of leaving the UI stuck on REC.
    if (currentRecordingState !== 'recording' && !isConnectionActive) {
      return
    }

    try {
      await livePublisher.stop()
      state$.recordingState.set('completion')
      state$.videoUri.set('live')
      state$.showInviteSheet.set(false)
    } catch (error) {
      logRecordingError(error)
      Alert.alert(
        'Stopping...',
        'The connection stopped locally, but the saved video may still finish processing.',
      )
      livePublishActions.reset()
      state$.recordingState.set('idle')
      state$.videoUri.set(null)
      state$.showInviteSheet.set(false)
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
    state$.showInviteSheet.set(false)

    try {
      // cancel() tears down the publisher and deletes the pending bondfire +
      // Mux live stream server-side via cancelLiveStream — single cleanup path.
      await livePublisher.cancel()
    } catch (error) {
      logRecordingError(error)
      const errorInfo = parseError(error)
      Alert.alert('Recording', getUserFacingErrorMessage(errorInfo))
    } finally {
      livePublishActions.reset()
      state$.recordingState.set('idle')
      state$.videoUri.set(null)
      state$.showInviteSheet.set(false)
    }
  }, [livePublisher, logRecordingError, state$])

  useEffect(() => {
    if (!shouldUseLivePublish || (isFocused && isAppActive)) {
      return
    }

    const currentRecordingState = state$.recordingState.get()
    if (currentRecordingState === 'recording' || currentRecordingState === 'stopping') {
      void stopLiveRecording()
      return
    }

    if (currentRecordingState === 'pre_connected' && !isFocused) {
      void cancelLiveRecording()
    }
  }, [cancelLiveRecording, isAppActive, isFocused, shouldUseLivePublish, state$, stopLiveRecording])

  const toggleLiveFacing = useCallback(() => {
    const currentRecordingState = state$.recordingState.get()
    if (
      currentRecordingState === 'pre_connected' ||
      currentRecordingState === 'recording' ||
      liveStatus === 'connecting' ||
      liveStatus === 'live' ||
      liveStatus === 'reconnecting'
    ) {
      // The native publisher owns the camera during preview and recording.
      livePublisher.swapCamera().catch((error) => {
        logRecordingError(error)
        const errorInfo = parseError(error)
        Alert.alert('Switch Camera Failed', getUserFacingErrorMessage(errorInfo))
      })
      state$.facing.set(state$.facing.get() === 'back' ? 'front' : 'back')
      return
    }

    toggleFacing()
  }, [livePublisher, liveStatus, logRecordingError, state$, toggleFacing])

  const shouldRenderCamera =
    cameraPermission?.granted && micPermission?.granted && isFocused && isAppActive

  // Reason the pre-connect guards refused to arm the camera, surfaced in the UI
  // instead of leaving the user on a silent spinner.
  const preConnectBlockReason = !shouldUseLivePublish
    ? null
    : !respondTo && !canCreate
      ? 'You have reached your plan limit. Upgrade to spark more Bondfires.'
      : !respondTo && !isPersonalCamp && camps !== undefined && !selectedCamp
        ? 'Choose a Camp before sparking a Bondfire.'
        : needsTradeTag
          ? 'This camp asks each spark to be a Need or an Offer.'
          : null

  useEffect(() => {
    if (
      !shouldUseLivePublish ||
      !shouldRenderCamera ||
      recordingState !== 'idle' ||
      preConnectFailed
    ) {
      return
    }

    void startLivePreConnect()
  }, [
    preConnectFailed,
    recordingState,
    shouldRenderCamera,
    shouldUseLivePublish,
    startLivePreConnect,
  ])

  // Clean up an abandoned pre-connect after 2 minutes in the background.
  useEffect(() => {
    if (!shouldUseLivePublish || recordingState !== 'pre_connected') {
      return
    }

    if (!isAppActive) {
      if (backgroundCancelTimeoutRef.current) {
        clearTimeout(backgroundCancelTimeoutRef.current)
      }
      backgroundCancelTimeoutRef.current = setTimeout(() => {
        void cancelLiveRecording()
      }, 120_000)
      return
    }

    if (backgroundCancelTimeoutRef.current) {
      clearTimeout(backgroundCancelTimeoutRef.current)
      backgroundCancelTimeoutRef.current = null
    }
  }, [cancelLiveRecording, isAppActive, recordingState, shouldUseLivePublish])

  // Keep the session from being reaped as stale while previewing or recording.
  // Mux sends no webhooks between stream start and disconnect, so without this
  // heartbeat the stale-session cron would disable healthy recordings longer
  // than its 5-minute threshold.
  useEffect(() => {
    if (
      !shouldUseLivePublish ||
      (recordingState !== 'pre_connected' && recordingState !== 'recording')
    ) {
      return
    }

    const interval = setInterval(() => {
      const sessionId = livePublishStore$.sessionId.get()
      if (sessionId) {
        touchLiveSession({ liveSessionId: sessionId as Id<'liveSessions'> }).catch(() => {})
      }
    }, 120_000)

    return () => clearInterval(interval)
  }, [recordingState, shouldUseLivePublish, touchLiveSession])

  // Expire an idle preview before the server hard-caps the pending session
  // (5 minutes). Without this, a user who lingers on the preview screen would
  // tap record against a stream the reaper already disabled.
  useEffect(() => {
    if (!shouldUseLivePublish || recordingState !== 'pre_connected') {
      return
    }

    const timeout = setTimeout(() => {
      state$.previewExpired.set(true)
      state$.preConnectFailed.set(true)
      void cancelLiveRecording()
    }, 240_000)

    return () => clearTimeout(timeout)
  }, [cancelLiveRecording, recordingState, shouldUseLivePublish, state$])

  // If the connection dies mid-recording, finalize the partial recording
  // instead of leaving the UI stuck on REC with nothing being ingested.
  useEffect(() => {
    if (!shouldUseLivePublish || recordingState !== 'recording' || liveStatus !== 'errored') {
      return
    }

    Alert.alert(
      'Connection Lost',
      'The live connection dropped. Everything recorded so far will be saved.',
    )
    void stopLiveRecording()
  }, [liveStatus, recordingState, shouldUseLivePublish, stopLiveRecording])

  const cancelLiveRecordingRef = useRef(cancelLiveRecording)
  useEffect(() => {
    cancelLiveRecordingRef.current = cancelLiveRecording
  }, [cancelLiveRecording])

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  // Mount-scoped unmount cleanup: cancel a provisioned-but-unstarted session.
  // Uses refs/observables so changing callback identities can't fire this early.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads latest state via observables at cleanup time
  useEffect(() => {
    return () => {
      const currentRecordingState = state$.recordingState.get()
      if (
        (currentRecordingState === 'pre_connected' || currentRecordingState === 'idle') &&
        livePublishStore$.recordId.get()
      ) {
        void cancelLiveRecordingRef.current()
      }
    }
  }, [])

  // Permission denied state
  if (!cameraPermission?.granted || !micPermission?.granted) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        paddingHorizontal={24}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack alignItems="center" gap={24}>
          <YStack
            width={100}
            height={100}
            borderRadius={50}
            backgroundColor={'$backgroundHover'}
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor={'$primary'}
          >
            <Flame size={50} color={'$primary'} />
          </YStack>
          <Text fontSize={20} fontWeight="600" textAlign="center">
            Camera and microphone access required
          </Text>
          <Text textAlign="center" color={'$placeholderColor'}>
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
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        gap={14}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <Spinner size="large" color={'$primary'} />
        <Text color={'$placeholderColor'}>Loading camp...</Text>
      </YStack>
    )
  }

  if (isSelectedCampUnavailable) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        padding={24}
        gap={16}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <Text fontSize={24} fontWeight="900" textAlign="center">
          Camp unavailable
        </Text>
        <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
          Choose an active camp before recording.
        </Text>
        <Button
          variant="primary"
          size="$lg"
          onPress={() => {
            state$.selectedCampId.set(null)
            state$.tradeTag.set(null)
            appActions.setCurrentCampId(null)
            router.replace(routes.create)
          }}
        >
          <Text color={'$color'} fontWeight="900">
            Choose Camp
          </Text>
        </Button>
      </YStack>
    )
  }

  if (!respondTo && !isPersonalCamp && !effectiveCampId) {
    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack paddingTop={64} paddingHorizontal={20} paddingBottom={16} gap={8}>
          <Text fontSize={28} fontWeight="900">
            Choose a Camp
          </Text>
          <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
            Every Bondfire starts in a camp.
          </Text>
        </YStack>
        {camps === undefined ? (
          <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
            <Spinner size="large" color={'$primary'} />
            <Text color={'$placeholderColor'}>Loading camps...</Text>
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
                      backgroundColor={'$backgroundHover'}
                      borderWidth={1}
                      borderColor={camp.color ?? '$borderColor'}
                      opacity={isPending ? 0.65 : 1}
                      gap={8}
                    >
                      <XStack justifyContent="space-between" alignItems="center" gap={12}>
                        <YStack flex={1} gap={3}>
                          <Text fontSize={17} fontWeight="900" numberOfLines={1}>
                            {camp.name}
                          </Text>
                          <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                            {camp.theme ?? 'Camp'}
                          </Text>
                        </YStack>
                        <Text
                          fontSize={12}
                          color={isActiveMember ? '$success' : '$placeholderColor'}
                          fontWeight="900"
                        >
                          {isPending ? 'Pending' : isActiveMember ? 'Joined' : 'Join'}
                        </Text>
                      </XStack>
                      <Text fontSize={14} color={'$color'} lineHeight={20}>
                        {camp.purpose}
                      </Text>
                    </YStack>
                  </Pressable>
                )
              })}
              {/* Personal Hearth — visually distinct from camp cards */}
              <Pressable onPress={handleOpenPersonalHearth}>
                <YStack
                  padding={14}
                  borderRadius={16}
                  backgroundColor={'rgba(217, 119, 54, 0.07)'}
                  borderWidth={1}
                  borderColor={'$primary'}
                  borderStyle="dashed"
                  gap={8}
                >
                  <XStack justifyContent="space-between" alignItems="center" gap={12}>
                    <XStack alignItems="center" gap={10} flex={1}>
                      <YStack
                        width={36}
                        height={36}
                        borderRadius={18}
                        backgroundColor={'rgba(217, 119, 54, 0.15)'}
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Flame size={18} color={'$primary'} />
                      </YStack>
                      <YStack flex={1} gap={2}>
                        <Text fontSize={16} fontWeight="900" color={'$primary'} numberOfLines={1}>
                          {personalCampDoc?.name ?? 'My Hearth'}
                        </Text>
                        <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                          Your personal space
                        </Text>
                      </YStack>
                    </XStack>
                    <Sparkles size={16} color={'$primary'} />
                  </XStack>
                  <Text fontSize={14} color={'$color'} lineHeight={20}>
                    Private sparks just for you. No camp rules, no audience — just your own fire.
                  </Text>
                </YStack>
              </Pressable>
            </YStack>
          </ScrollView>
        )}
      </YStack>
    )
  }

  if (!respondTo && !isPersonalCamp && selectedCamp && !promptDismissed) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        padding={24}
        gap={18}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack
          width={78}
          height={78}
          borderRadius={22}
          backgroundColor={selectedCamp.color ?? '$backgroundHover'}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={38} color={'$color'} />
        </YStack>
        <Text fontSize={24} fontWeight="900" textAlign="center">
          {selectedCamp.name}
        </Text>
        <Text fontSize={16} color={'$color'} textAlign="center" lineHeight={23}>
          {selectedCamp.defaultPrompt ?? selectedCamp.purpose}
        </Text>
        <Button variant="primary" size="$lg" onPress={() => state$.promptDismissed.set(true)}>
          <Text color={'$color'} fontWeight="900">
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
        backgroundColor={'$background'}
        padding={24}
        justifyContent="center"
        gap={18}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <Text fontSize={24} fontWeight="900" textAlign="center">
          Need or Offer?
        </Text>
        <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
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
              <Text color={'$color'} fontWeight="900" textTransform="capitalize">
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
      : isPersonalCamp
        ? 'Your Personal Bondfire is being processed. Invite someone to join the conversation!'
        : 'Awesome, great video! We are getting it ready now. It may take up to two minutes for your video to show in Discover, Recent, and Active.'

    return (
      <CompletionScreen
        detail={completionDetail}
        onContinue={() => {
          const targetBondfireId = respondTo ?? liveRecordId
          livePublishActions.reset()
          if (isPersonalCamp) {
            // Live publish already has the Convex bondfire ID; background upload doesn't yet
            const personalBondfireId = shouldUseLivePublish && liveRecordId ? liveRecordId : 'new'
            router.replace(
              routes.personalCampWithInvite(
                personalBondfireId,
                personalCreateStartedAtRef.current ?? Date.now(),
              ),
            )
            return
          }
          if (shouldUseLivePublish && targetBondfireId) {
            router.replace(routes.bondfire(targetBondfireId))
            return
          }
          router.replace(routes.feed)
        }}
      />
    )
  }

  // Processing state
  if (recordingState === 'processing') {
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

  if (shouldUseLivePublish) {
    const isPreConnected = recordingState === 'pre_connected'
    const isLiveRecording = recordingState === 'recording'
    const isLiveBusy =
      liveStatus === 'creating' || liveStatus === 'connecting' || liveStatus === 'stopping'
    const statusLabel =
      liveStatus === 'creating'
        ? 'Preparing camera...'
        : liveStatus === 'connecting'
          ? 'Starting...'
          : liveStatus === 'stopping'
            ? 'Saving...'
            : isLiveRecording
              ? liveStatus === 'reconnecting'
                ? 'Reconnecting...'
                : '● REC'
              : isPreConnected
                ? 'Tap to record'
                : 'Preparing camera...'
    const showPreConnectError = !isLiveRecording && !isPreConnected && preConnectFailed
    const showPreConnectBlocked =
      !isLiveRecording && !isPreConnected && !preConnectFailed && !!preConnectBlockReason
    const showBusySpinner =
      !isLiveRecording &&
      !showPreConnectError &&
      !showPreConnectBlocked &&
      (isLiveBusy || !isPreConnected)

    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
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
              <Pressable
                onPress={() => {
                  if (isLiveRecording) {
                    // Confirm before stopping so X can't accidentally publish.
                    Alert.alert('Stop recording?', 'Your Bondfire will be saved and shared.', [
                      { text: 'Keep Recording', style: 'cancel' },
                      { text: 'Stop & Save', onPress: () => void stopLiveRecording() },
                    ])
                    return
                  }
                  if (isPreConnected) {
                    void cancelLiveRecording()
                  }
                  handleBack()
                }}
              >
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

              {isLiveRecording && (
                <YStack
                  backgroundColor={showRecordingLimitCountdown ? '$warning' : '$error'}
                  paddingHorizontal={16}
                  paddingVertical={6}
                  borderRadius={16}
                >
                  <Text color={'$color'} fontWeight="800" fontSize={14}>
                    {`● REC ${recordingTimerLabel}`}
                  </Text>
                </YStack>
              )}

              <Pressable
                onPress={toggleLiveFacing}
                disabled={isLiveBusy || (!isPreConnected && !isLiveRecording)}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor="rgba(31, 32, 35, 0.7)"
                  alignItems="center"
                  justifyContent="center"
                  opacity={isLiveBusy || (!isPreConnected && !isLiveRecording) ? 0.5 : 1}
                >
                  <SwitchCamera size={22} color={'$color'} />
                </YStack>
              </Pressable>
            </XStack>

            <YStack
              position="absolute"
              left={0}
              right={0}
              top="40%"
              alignItems="center"
              pointerEvents="box-none"
            >
              {isPreConnected && !isLiveRecording && !isLiveBusy && (
                <YStack alignItems="center" gap={12} pointerEvents="none">
                  <XStack alignItems="center" gap={8}>
                    <Flame size={28} color={'$primary'} />
                    <Text color={'$color'} fontSize={22} fontWeight="700">
                      {respondTo ? 'Respond' : (selectedCamp?.name ?? 'Spark a Bondfire')}
                    </Text>
                  </XStack>
                  <Text color={'$placeholderColor'} fontSize={14}>
                    Tap to record
                  </Text>
                </YStack>
              )}

              {showPreConnectError && (
                <YStack alignItems="center" gap={16}>
                  <Text color={'$color'} fontSize={18} fontWeight="700">
                    {previewExpired ? 'Camera timed out' : "Camera couldn't start"}
                  </Text>
                  <Pressable
                    onPress={() => {
                      state$.preConnectFailed.set(false)
                      void startLivePreConnect()
                    }}
                  >
                    <YStack
                      paddingHorizontal={24}
                      paddingVertical={10}
                      borderRadius={20}
                      backgroundColor={'$primary'}
                    >
                      <Text color={'$color'} fontWeight="800">
                        Try Again
                      </Text>
                    </YStack>
                  </Pressable>
                </YStack>
              )}

              {showPreConnectBlocked && (
                <YStack alignItems="center" gap={16} paddingHorizontal={32}>
                  <Text color={'$color'} fontSize={16} fontWeight="700" textAlign="center">
                    {preConnectBlockReason}
                  </Text>
                  {needsTradeTag && (
                    <XStack gap={12}>
                      <Pressable onPress={() => state$.tradeTag.set('need')}>
                        <YStack
                          paddingHorizontal={24}
                          paddingVertical={10}
                          borderRadius={20}
                          backgroundColor={'$primary'}
                        >
                          <Text color={'$color'} fontWeight="800">
                            Need
                          </Text>
                        </YStack>
                      </Pressable>
                      <Pressable onPress={() => state$.tradeTag.set('offer')}>
                        <YStack
                          paddingHorizontal={24}
                          paddingVertical={10}
                          borderRadius={20}
                          backgroundColor={'$primary'}
                        >
                          <Text color={'$color'} fontWeight="800">
                            Offer
                          </Text>
                        </YStack>
                      </Pressable>
                    </XStack>
                  )}
                </YStack>
              )}

              {showBusySpinner && (
                <YStack alignItems="center" gap={12} pointerEvents="none">
                  <Spinner size="large" color={'$color'} />
                  <Text color={'$color'} fontSize={18} fontWeight="700">
                    {statusLabel}
                  </Text>
                </YStack>
              )}
            </YStack>

            <YStack position="absolute" left={0} right={0} bottom={40} alignItems="center">
              {(isPreConnected || isLiveRecording) && liveRecordId && !respondTo ? (
                <Pressable onPress={() => state$.showInviteSheet.set(true)}>
                  <YStack
                    paddingHorizontal={14}
                    paddingVertical={8}
                    borderRadius={16}
                    backgroundColor="rgba(31, 32, 35, 0.7)"
                    marginBottom={14}
                  >
                    <Text color={'$color'} fontSize={13} fontWeight="800">
                      Share Link
                    </Text>
                  </YStack>
                </Pressable>
              ) : null}
              <Pressable
                disabled={isLiveBusy || (!isPreConnected && !isLiveRecording)}
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
                  borderColor={'$color'}
                  alignItems="center"
                  justifyContent="center"
                  backgroundColor={isLiveRecording ? '$error' : 'transparent'}
                  opacity={isLiveBusy || (!isPreConnected && !isLiveRecording) ? 0.7 : 1}
                >
                  {isLiveBusy ? (
                    <Spinner size="small" color={'$color'} />
                  ) : (
                    <YStack
                      width={isLiveRecording ? 30 : 60}
                      height={isLiveRecording ? 30 : 60}
                      borderRadius={isLiveRecording ? 6 : 30}
                      backgroundColor={isLiveRecording ? '$color' : '$primary'}
                    />
                  )}
                </YStack>
              </Pressable>

              <Text color={'$placeholderColor'} fontSize={13} marginTop={12}>
                {isLiveRecording
                  ? showRecordingLimitCountdown && autoStopStatusLabel
                    ? autoStopStatusLabel
                    : 'Tap to stop'
                  : statusLabel}
              </Text>
            </YStack>
            {liveRecordId && !respondTo ? (
              <InviteSheet
                mode="bondfire"
                id={liveRecordId as Id<'bondfires'>}
                open={showInviteSheet}
                onClose={() => state$.showInviteSheet.set(false)}
              />
            ) : null}
          </>
        ) : (
          <YStack flex={1} />
        )}
      </YStack>
    )
  }

  // Camera view
  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
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
            telemetry.error('create:camera', 'Camera mount error', {
              platform: Platform.OS,
              message,
            })
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
            <Pressable onPress={handleBack}>
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

            {recordingState === 'recording' && (
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
                  <Spinner size="small" color={'$color'} />
                ) : (
                  <SwitchCamera size={22} color={'$color'} />
                )}
              </YStack>
            </Pressable>
          </XStack>

          {/* Title */}
          <YStack flex={1} justifyContent="center" alignItems="center">
            {recordingState === 'idle' && (
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

            {recordingState === 'stopping' && (
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
                borderColor={'$color'}
                alignItems="center"
                justifyContent="center"
                backgroundColor={
                  recordingState === 'recording' || recordingState === 'stopping'
                    ? '$error'
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
                  <Spinner size="small" color={'$color'} />
                ) : (
                  <YStack
                    width={recordingState === 'recording' ? 30 : 60}
                    height={recordingState === 'recording' ? 30 : 60}
                    borderRadius={recordingState === 'recording' ? 6 : 30}
                    backgroundColor={recordingState === 'recording' ? '$color' : '$primary'}
                  />
                )}
              </YStack>
            </Pressable>

            <Text color={'$placeholderColor'} fontSize={13} marginTop={12}>
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
      <SparkTitleSheet
        open={sparkTitleSheetCamp !== null}
        campName={sparkTitleSheetCamp?.name}
        onSubmit={handleSparkTitleSubmit}
        onCancel={() => setSparkTitleSheetCamp(null)}
      />
    </YStack>
  )
}
