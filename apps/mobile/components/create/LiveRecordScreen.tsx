import {
  buildErrorReportMailto,
  getDefaultBondfireTitle,
  getUserFacingErrorMessage,
  type LivePublishStatus,
  livePublishActions,
  livePublishStore$,
  parseError,
  recordingActions,
  recordingStore$,
  shouldShowReportIssue,
  telemetry,
  useAppThemeColors,
  useLivePublisher,
} from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame, SwitchCamera, X } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Linking, Pressable, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { BondfireLivePublisher, LivePublisherView } from '../../modules/bondfire-live-publisher'
import { InviteSheet } from '../InviteSheet'
import { type CampWithMembership, formatRecordingClock, type TradeTag } from './shared'

const keepAwakeTag = 'create-recording'

interface LiveRecordScreenProps {
  respondTo: string | undefined
  isPersonalCamp: boolean
  effectiveCampId: Id<'camps'> | undefined
  selectedCamp: CampWithMembership | null
  selectedCampTags: TradeTag[] | undefined
  effectiveMaxRecordingSeconds: number | undefined
  currentUser: FunctionReturnType<typeof api.users.current> | undefined
  canCreate: boolean
  needsTradeTag: boolean
  onSelectTradeTag: (tag: TradeTag) => void
  /** True once the camp list query has resolved (always false for responses). */
  isCampListLoaded: boolean
  shouldRenderCamera: boolean
  onBack: () => void
  logRecordingError: (error: unknown) => void
  /** Owned by the create router — the completion screen reads it for routing. */
  personalCreateStartedAtRef: MutableRefObject<number | null>
}

export function LiveRecordScreen({
  respondTo,
  isPersonalCamp,
  effectiveCampId,
  selectedCamp,
  selectedCampTags,
  effectiveMaxRecordingSeconds,
  currentUser,
  canCreate,
  needsTradeTag,
  onSelectTradeTag,
  isCampListLoaded,
  shouldRenderCamera,
  onBack,
  logRecordingError,
  personalCreateStartedAtRef,
}: LiveRecordScreenProps) {
  const { statusBarStyle } = useAppThemeColors()
  const isFocused = useIsFocused()

  const preConnectInFlightRef = useRef(false)
  const backgroundCancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const state$ = useObservable({
    isAppActive: AppState.currentState === 'active',
    isFocused: isFocused,
    showInviteSheet: false,
  })

  const isAppActive = useValue(state$.isAppActive)
  const showInviteSheet = useValue(state$.showInviteSheet)
  const phase = useValue(recordingStore$.phase)
  const recordingDuration = useValue(recordingStore$.recordingDuration)
  const preConnectFailed = useValue(recordingStore$.preConnectFailed)
  const previewExpired = useValue(recordingStore$.previewExpired)
  const liveStatus = useValue(livePublishStore$.status)
  const liveRecordId = useValue(livePublishStore$.recordId)

  const createLiveStream = useAction(api.videos.createLiveStream)
  const endLiveStream = useAction(api.videos.endLiveStream)
  const cancelLiveStream = useAction(api.videos.cancelLiveStream)
  const markBondfireLive = useMutation(api.videos.markBondfireLive)
  const touchLiveSession = useMutation(api.videos.touchLiveSession)

  const recordingTimeRemainingSeconds = effectiveMaxRecordingSeconds
    ? Math.max(0, effectiveMaxRecordingSeconds - recordingDuration)
    : undefined
  const showRecordingLimitCountdown =
    recordingTimeRemainingSeconds !== undefined &&
    recordingTimeRemainingSeconds <= 60 &&
    (phase === 'recording' || liveStatus === 'live' || liveStatus === 'reconnecting')
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

  // Clean up any orphaned live sessions from a previous crash so Mux billing
  // stops immediately and the bondfire transitions out of 'live' status. The
  // 5-minute stale-session cron is the durable fallback; this is best-effort.
  const listMyActiveSessions = useQuery(api.liveSessions.listMyActive, {})
  const activeSessions = listMyActiveSessions ?? []
  useEffect(() => {
    if (activeSessions.length === 0) return

    // Only sweep while live publishing is fully idle. createLiveStream inserts
    // the liveSessions row before the action resolves, so this reactive query
    // can deliver our own in-flight session before sessionId lands in the
    // store — sweeping then would cancel the session we're about to record on.
    if (livePublishStore$.status.peek() !== 'idle') return

    // Don't clean up sessions that are currently being used by this screen.
    const currentSessionId = livePublishStore$.sessionId.peek()
    const orphaned = activeSessions.filter((s) => s._id !== currentSessionId)

    for (const session of orphaned) {
      telemetry.warn('live:orphan', 'Cleaning up orphaned live session from previous crash', {
        sessionId: session._id,
        status: session.status,
      })
      cancelLiveStream({
        liveSessionId: session._id as Id<'liveSessions'>,
        reason: 'crash_recovery',
      }).catch((err) => {
        telemetry.error('live:orphan_cleanup', 'Failed to clean up orphaned live session', {
          sessionId: session._id,
          error: String(err),
        })
      })
    }
  }, [activeSessions, cancelLiveStream])

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
      if (backgroundCancelTimeoutRef.current) {
        clearTimeout(backgroundCancelTimeoutRef.current)
        backgroundCancelTimeoutRef.current = null
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

  // Keep screen awake while recording or the transport is busy. (The legacy
  // phase terms — stopping/processing/uploading — live in LegacyRecordScreen.)
  useEffect(() => {
    const shouldKeepAwake =
      isFocused &&
      isAppActive &&
      (phase === 'recording' ||
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
  }, [phase, liveStatus, isFocused, isAppActive])

  const startLivePreConnect = useCallback(async () => {
    const currentStatus = livePublishStore$.status.get()
    const currentRecordingState = recordingStore$.phase.get()
    const recoveredStatuses: LivePublishStatus[] = [
      'idle',
      'ended',
      'errored',
      'stream_stopped_unexpectedly',
      'endpoint_closed',
    ]
    if (
      preConnectInFlightRef.current ||
      currentRecordingState !== 'idle' ||
      !recoveredStatuses.includes(currentStatus)
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
      recordingStore$.preConnectFailed.set(false)
      recordingStore$.previewExpired.set(false)
      recordingStore$.recordingDuration.set(0)
      recordingStore$.videoUri.set(null)
      recordingStore$.progressStage.set('Preparing camera...')
      if (isPersonalCamp) {
        personalCreateStartedAtRef.current = Date.now()
      }

      // Camera preview only — nothing is published or recorded until the
      // user taps record and the RTMP connection opens.
      await livePublisher.preview({
        initialCamera: recordingStore$.facing.get() === 'back' ? 'back' : 'front',
      })

      if (!respondTo) {
        // Provision the live stream + pending bondfire so the share link
        // works while waiting, but defer publishing to the record tap.
        // Seed the default title at creation so the bondfire is never
        // untitled if the user skips the completion-screen title edit.
        await livePublisher.provision({
          campId: effectiveCampId,
          personalCamp: isPersonalCamp || undefined,
          tags: selectedCampTags,
          title: getDefaultBondfireTitle(currentUser, selectedCamp?.name) || undefined,
          pending: true,
        })
      }

      recordingActions.setPhase('pre_connected', 'live pre-connect succeeded')
      state$.showInviteSheet.set(false)
    } catch (error) {
      logRecordingError(error)
      livePublishActions.reset()
      recordingActions.setPhase('idle', 'live pre-connect failed')
      recordingStore$.preConnectFailed.set(true)
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
    currentUser,
    effectiveCampId,
    isPersonalCamp,
    livePublisher,
    logRecordingError,
    needsTradeTag,
    personalCreateStartedAtRef,
    respondTo,
    selectedCamp,
    selectedCampTags,
    state$,
  ])

  const startLiveRecording = useCallback(async () => {
    if (recordingStore$.phase.get() !== 'pre_connected') {
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

    const initialCamera =
      recordingStore$.facing.get() === 'back' ? ('back' as const) : ('front' as const)

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
    recordingStore$.recordingDuration.set(0)
    recordingActions.setPhase('recording', 'live record tap')
  }, [livePublisher, logRecordingError, markBondfireLive, respondTo, selectedCampTags, state$])

  const stopLiveRecording = useCallback(async () => {
    const currentRecordingState = recordingStore$.phase.get()
    const isConnectionActive =
      liveStatus === 'connecting' || liveStatus === 'live' || liveStatus === 'reconnecting'
    // Also allow stopping when the connection errored mid-recording so the
    // partial recording is finalized instead of leaving the UI stuck on REC.
    if (currentRecordingState !== 'recording' && !isConnectionActive) {
      return
    }

    try {
      const result = await livePublisher.stop()
      // The recording is captured the moment the publisher stops. Mux finalizes
      // the VOD via its reconnect window and the asset.ready webhook saves it,
      // so always advance to the completion/processing screen rather than
      // resetting to idle (which read as "recording lost").
      recordingActions.setPhase('completion', 'live stop succeeded')
      recordingStore$.videoUri.set('live')
      state$.showInviteSheet.set(false)

      if (result.backendNotified === false) {
        // Stopped while offline / the backend was unreachable, so Mux was never
        // signaled to end recording early. It still finalizes via the reconnect
        // window once we're back online — set expectations so the creator
        // doesn't think the recording vanished.
        Alert.alert(
          'Saving your Bondfire',
          "You're offline, so this didn't finalize right away. Your recording will finish processing once you're back online.",
        )
      }
    } catch (error) {
      // Only a native publisher.stop() failure reaches here. The local capture
      // pipeline is in an unknown state, so reset to idle.
      logRecordingError(error)
      Alert.alert('Recording Failed', "We couldn't stop the recording cleanly. Please try again.")
      livePublishActions.reset()
      recordingActions.setPhase('idle', 'live stop failed')
      recordingStore$.videoUri.set(null)
      state$.showInviteSheet.set(false)
    }
  }, [livePublisher, liveStatus, logRecordingError, state$])

  // Auto-stop at the recording duration cap.
  // NOTE: the pre-refactor create screen routed this through the legacy
  // stopRecording() first whenever phase === 'recording', which in live mode
  // finalized zero segments and surfaced "Recording Failed". The live screen
  // now stops the live publisher directly.
  useEffect(() => {
    if (!effectiveMaxRecordingSeconds || recordingDuration < effectiveMaxRecordingSeconds) {
      return
    }

    if (phase === 'recording' || liveStatus === 'live' || liveStatus === 'reconnecting') {
      void stopLiveRecording()
    }
  }, [liveStatus, phase, recordingDuration, effectiveMaxRecordingSeconds, stopLiveRecording])

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
      recordingActions.setPhase('idle', 'live cancel')
      recordingStore$.videoUri.set(null)
      state$.showInviteSheet.set(false)
    }
  }, [livePublisher, logRecordingError, state$])

  useEffect(() => {
    if (isFocused && isAppActive) {
      return
    }

    const currentRecordingState = recordingStore$.phase.get()
    if (currentRecordingState === 'recording' || currentRecordingState === 'stopping') {
      void stopLiveRecording()
      return
    }

    if (currentRecordingState === 'pre_connected' && !isFocused) {
      void cancelLiveRecording()
    }
  }, [cancelLiveRecording, isAppActive, isFocused, stopLiveRecording])

  const toggleLiveFacing = useCallback(() => {
    const currentRecordingState = recordingStore$.phase.get()
    if (
      currentRecordingState === 'pre_connected' ||
      currentRecordingState === 'recording' ||
      liveStatus === 'connecting' ||
      liveStatus === 'live' ||
      liveStatus === 'reconnecting'
    ) {
      // The native publisher owns the camera during preview and recording.
      // Only flip the tracked facing once the native swap actually succeeds,
      // so a failed swap can't leave JS and the capture pipeline disagreeing.
      livePublisher
        .swapCamera()
        .then(() => {
          recordingStore$.facing.set(recordingStore$.facing.get() === 'back' ? 'front' : 'back')
        })
        .catch((error) => {
          logRecordingError(error)
          const errorInfo = parseError(error)
          Alert.alert('Switch Camera Failed', getUserFacingErrorMessage(errorInfo))
        })
      return
    }

    // Publisher inactive — mirror the legacy toggleFacing fallback: just flip
    // the requested facing for the next preview. ('stopping' never occurs on
    // the live path, but keep the original early return for parity.)
    if (recordingStore$.phase.get() === 'stopping') {
      return
    }

    const currentTargetFacing = recordingStore$.pendingFacing.get() ?? recordingStore$.facing.get()
    const nextFacing = currentTargetFacing === 'back' ? 'front' : 'back'
    recordingStore$.pendingFacing.set(null)
    recordingStore$.isCameraReady.set(false)
    recordingStore$.cameraMountError.set(null)
    recordingStore$.facing.set(nextFacing)
  }, [livePublisher, liveStatus, logRecordingError])

  // Reason the pre-connect guards refused to arm the camera, surfaced in the UI
  // instead of leaving the user on a silent spinner.
  const preConnectBlockReason =
    !respondTo && !canCreate
      ? 'You have reached your plan limit. Upgrade to spark more Bondfires.'
      : !respondTo && !isPersonalCamp && isCampListLoaded && !selectedCamp
        ? 'Choose a Camp before sparking a Bondfire.'
        : needsTradeTag
          ? 'This camp asks each spark to be a Need or an Offer.'
          : null

  useEffect(() => {
    if (!shouldRenderCamera || phase !== 'idle' || preConnectFailed) {
      return
    }

    void startLivePreConnect()
  }, [preConnectFailed, phase, shouldRenderCamera, startLivePreConnect])

  // Clean up an abandoned pre-connect after 2 minutes in the background.
  useEffect(() => {
    if (phase !== 'pre_connected') {
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
  }, [cancelLiveRecording, isAppActive, phase])

  // Keep the session from being reaped as stale while previewing or recording.
  // Mux sends no webhooks between stream start and disconnect, so without this
  // heartbeat the stale-session cron would disable healthy recordings longer
  // than its 5-minute threshold.
  useEffect(() => {
    if (phase !== 'pre_connected' && phase !== 'recording') {
      return
    }

    const interval = setInterval(() => {
      const sessionId = livePublishStore$.sessionId.get()
      if (sessionId) {
        touchLiveSession({ liveSessionId: sessionId as Id<'liveSessions'> }).catch(() => {})
      }
    }, 120_000)

    return () => clearInterval(interval)
  }, [phase, touchLiveSession])

  // Expire an idle preview before the server hard-caps the pending session
  // (5 minutes). Without this, a user who lingers on the preview screen would
  // tap record against a stream the reaper already disabled.
  useEffect(() => {
    if (phase !== 'pre_connected') {
      return
    }

    const timeout = setTimeout(() => {
      recordingStore$.previewExpired.set(true)
      recordingStore$.preConnectFailed.set(true)
      void cancelLiveRecording()
    }, 240_000)

    return () => clearTimeout(timeout)
  }, [cancelLiveRecording, phase])

  // If the connection dies or the encoder unexpectedly stops mid-recording,
  // finalize the partial recording instead of leaving the UI stuck on REC.
  useEffect(() => {
    const isDead =
      liveStatus === 'errored' ||
      liveStatus === 'stream_stopped_unexpectedly' ||
      liveStatus === 'endpoint_closed'

    if (phase !== 'recording' || !isDead) {
      return
    }

    // Don't show an alert — the status transition is visible in the UI and
    // the completed upload will show whatever was captured.
    void stopLiveRecording()
  }, [liveStatus, phase, stopLiveRecording])

  const cancelLiveRecordingRef = useRef(cancelLiveRecording)
  useEffect(() => {
    cancelLiveRecordingRef.current = cancelLiveRecording
  }, [cancelLiveRecording])

  // Mount-scoped unmount cleanup: cancel a provisioned-but-unstarted session.
  // Uses refs/observables so changing callback identities can't fire this early.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads latest state via observables at cleanup time
  useEffect(() => {
    return () => {
      const currentRecordingState = recordingStore$.phase.get()
      if (
        (currentRecordingState === 'pre_connected' || currentRecordingState === 'idle') &&
        livePublishStore$.recordId.get()
      ) {
        void cancelLiveRecordingRef.current()
      }
    }
  }, [])

  const isPreConnected = phase === 'pre_connected'
  const isLiveRecording = phase === 'recording'
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
                onBack()
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
                    recordingStore$.preConnectFailed.set(false)
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
                    <Pressable onPress={() => onSelectTradeTag('need')}>
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
                    <Pressable onPress={() => onSelectTradeTag('offer')}>
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
