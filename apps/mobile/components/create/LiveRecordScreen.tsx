import {
  buildErrorReportMailto,
  freeUpgradeActions,
  getDefaultBondfireTitle,
  getUserFacingErrorMessage,
  LIVE_DEFAULT_VIDEO_BITRATE,
  LIVE_DEFAULT_VIDEO_FPS,
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
  usePresence,
} from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame, SwitchCamera, X } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as Network from 'expo-network'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Linking, Platform, Pressable, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { BondfireLivePublisher, LivePublisherView } from '../../modules/bondfire-live-publisher'
import { InviteSheet } from '../InviteSheet'
import { ViewerPresenceStack } from '../ViewerPresenceStack'
import { type CampWithMembership, formatRecordingClock, type TradeTag } from './shared'

const keepAwakeTag = 'create-recording'
// Thermal mitigation ladder, indexed by normalized thermal level (0–2 across
// both platforms; see getThermalState). Level 3 (critical) auto-stops instead.
// Android applies only the bitrate — an fps change there would force a
// MediaCodec reconfigure mid-stream.
const THERMAL_QUALITY_LADDER = [
  { bitrate: LIVE_DEFAULT_VIDEO_BITRATE, fps: LIVE_DEFAULT_VIDEO_FPS }, // nominal
  { bitrate: 1_500_000, fps: 24 }, // fair / moderate
  { bitrate: 800_000, fps: 15 }, // serious / severe
] as const
const THERMAL_POLL_INTERVAL_MS = 10_000
// Consecutive cooler polls required before stepping quality back up, so an
// oscillating thermal level doesn't flap the encoder settings.
const THERMAL_STEP_UP_POLLS = 3
const EARLY_LIVE_DROP_MS = 8_000
// Upper bound for the never-started cancel path. Cancelling deletes the
// session + record row, so a wrong verdict destroys real footage — cap the
// blast radius: every observed never-started failure dies within ~31s (Mux's
// idle disconnect), so past 60s we finalize instead and let stop()'s
// authoritative recordingStarted flag (Mux server truth) decide the UX.
const NEVER_STARTED_CANCEL_MAX_MS = 60_000
const LIVE_CAMERA_SWAP_TIMEOUT_MS = 5_000
const LIVE_CAMERA_SWAP_TIMEOUT_MESSAGE =
  'Could not switch cameras while recording. Please finish your recording and try switching before starting your next one.'

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
  /**
   * Pre-existing draft bondfire to activate (Hearth pre-recording invite flow).
   * When set, the live session attaches to this row instead of creating a new
   * bondfire on recording completion.
   */
  draftBondfireId?: string
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
  draftBondfireId,
}: LiveRecordScreenProps) {
  const { statusBarStyle } = useAppThemeColors()
  const isFocused = useIsFocused()

  const preConnectInFlightRef = useRef(false)
  // Monotonic id per arm attempt. The preview-timeout late-recovery handler
  // captures the generation it belongs to and acts only if no newer arm has
  // started since — an in-flight-ref check alone would let a stale handler
  // cancel a newer arm that already finished (ref back to false).
  const previewArmGenerationRef = useRef(0)
  const backgroundCancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Debounce timer for tearing down a provisioned-but-unstarted session when
  // the screen loses focus. useIsFocused() can flap during navigation
  // transitions; cancelling on the first blur let the auto-arm effect rebuild
  // the session immediately, producing an infinite provision/cancel loop (the
  // UI flickered between "Tap to record" and "Preparing camera..."). We only
  // act on a blur that persists past this grace window.
  const blurCancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Single-fires the stale-pre-connect reconcile per pre_connected episode so a
  // re-render (useLivePublisher returns a fresh object each time) can't fire
  // overlapping teardowns. Reset once the phase leaves pre_connected.
  const staleReconcileFiredRef = useRef(false)
  // A pre-connected screen owns the native camera preview from the moment it
  // arms, but the eagerly provisioned Mux session may still be in flight (or
  // may have failed). Keep preview ownership separate from ingest ownership so
  // blur/unmount can release the camera either way.
  const ownsPreviewRef = useRef(false)
  const cancelInFlightRef = useRef<Promise<void> | null>(null)
  // Eager provisioning state: the Mux stream is provisioned in the background
  // while the user frames the shot, so the record tap only opens the RTMP
  // connection. The args key detects camp/tags/title drift between provision
  // time and tap time; the attempt counter cancels superseded chains.
  const provisionInFlightRef = useRef<Promise<void> | null>(null)
  const provisionedArgsKeyRef = useRef<string | null>(null)
  const provisionedRecordTypeRef = useRef<'bondfire' | 'response' | null>(null)
  const provisionAttemptRef = useRef(0)
  // Thermal mitigation state (see the thermal effect below). Refs so effect
  // re-runs don't re-fire telemetry or re-apply encoder settings; reset when
  // the phase leaves 'recording'.
  const thermalLastLevelRef = useRef(-1)
  const thermalAppliedLevelRef = useRef(0)
  const thermalCoolPollsRef = useRef(0)
  const thermalStoppingRef = useRef(false)
  const thermalCheckInFlightRef = useRef(false)
  const liveTerminalRecoveryFiredRef = useRef(false)
  const liveCameraSwapInFlightRef = useRef(false)

  const state$ = useObservable({
    isAppActive: AppState.currentState === 'active',
    isFocused: isFocused,
    showInviteSheet: false,
    thermalWarning: false,
    // True while a record tap is being serviced (waiting out an in-flight
    // eager provision, connecting, or running the full-start fallback).
    // Drives the busy UI and blocks double-taps — liveStatus alone can't,
    // because 'creating' now also means a background eager provision.
    isTapStarting: false,
  })

  const isAppActive = useValue(state$.isAppActive)
  const showInviteSheet = useValue(state$.showInviteSheet)
  const isTapStarting = useValue(state$.isTapStarting)
  const thermalWarning = useValue(state$.thermalWarning)
  const phase = useValue(recordingStore$.phase)
  const recordingDuration = useValue(recordingStore$.recordingDuration)
  const progressStage = useValue(recordingStore$.progressStage)
  const preConnectFailed = useValue(recordingStore$.preConnectFailed)
  const previewExpired = useValue(recordingStore$.previewExpired)
  const liveStatus = useValue(livePublishStore$.status)
  const liveRecordId = useValue(livePublishStore$.recordId)

  // Presence: track viewers watching the live bondfire being recorded
  const { viewers: liveViewers } = usePresence({
    videoType: 'bondfire',
    videoId: liveRecordId ?? undefined,
    isActive: liveStatus === 'live',
    isScreenFocused: isFocused,
    isAppActive: isAppActive,
    currentUserId: currentUser?._id,
  })

  const createLiveStream = useAction(api.videos.createLiveStream)
  const endLiveStream = useAction(api.videos.endLiveStream)
  const cancelLiveStream = useAction(api.videos.cancelLiveStream)
  const touchLiveSession = useMutation(api.videos.touchLiveSession)
  const markBondfireLive = useMutation(api.videos.markBondfireLive)

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
        draftBondfireId: draftBondfireId as Id<'bondfires'> | undefined,
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
  // useLivePublisher intentionally exposes imperative methods, but its return
  // object is recreated as callback dependencies change. Keep the latest
  // instance in a ref so eager-provision scheduling is driven only by the
  // values that define a stream, not by unrelated renders/status updates.
  const livePublisherRef = useRef(livePublisher)
  livePublisherRef.current = livePublisher

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
      if (blurCancelTimeoutRef.current) {
        clearTimeout(blurCancelTimeoutRef.current)
        blurCancelTimeoutRef.current = null
      }
    }
  }, [])

  // Track app active state (external subscription - keep useEffect).
  // Also logs lifecycle breadcrumbs during recording so we can reconstruct
  // what happened before a crash.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (appState) => {
      state$.isAppActive.set(appState === 'active')

      // Log lifecycle breadcrumbs during active recording
      if (phase === 'recording' || liveStatus === 'connecting' || liveStatus === 'reconnecting') {
        const stateMap: Record<string, string> = {
          active: 'active',
          background: 'background',
          inactive: 'inactive',
        }
        telemetry.breadcrumb('live:app_state', {
          state: stateMap[appState] ?? appState,
          phase,
          liveStatus,
          sessionId: livePublishStore$.sessionId.peek(),
        })
      }
    })

    return () => {
      subscription.remove()
    }
  }, [state$, phase, liveStatus])

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
    const currentRecordingState = recordingStore$.phase.get()
    let currentStatus = livePublishStore$.status.get()

    // Self-heal a publisher store orphaned by an interrupted provision. When the
    // create screen remounts mid-provision (duplicate-mount churn), its unmount
    // resets the recording phase to 'idle' but leaves livePublishStore at
    // 'creating'/'ready'. With phase idle, no ingest owned here, and nothing in
    // flight, that limbo can never self-clear — and the guard below would refuse
    // to re-arm, stranding the camera on "Preparing camera..." indefinitely
    // (the telltale: a live preview with no live:provision ever firing).
    // Resetting lets this call provision a fresh, recordable session; any Mux
    // session the dead instance actually created is reaped by the orphan sweep.
    if (
      currentRecordingState === 'idle' &&
      (currentStatus === 'creating' || currentStatus === 'ready') &&
      !preConnectInFlightRef.current &&
      !livePublisher.hasProvisionedIngest()
    ) {
      telemetry.warn(
        'live:preconnect',
        'Recovering orphaned publisher state before arming camera',
        { staleStatus: currentStatus },
      )
      livePublishActions.reset()
      currentStatus = livePublishStore$.status.get()
    }

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
      // A hung native camera start would otherwise leave preConnectInFlightRef
      // set forever (the finally below never runs), which the arm guard reads
      // as "arm in progress" — permanently blocking every retry until app
      // restart while the user stares at "Preparing camera...".
      const PREVIEW_TIMEOUT_MS = 25_000
      const armGeneration = ++previewArmGenerationRef.current
      const previewPromise = livePublisher.preview({
        initialCamera: recordingStore$.facing.get() === 'back' ? 'back' : 'front',
      })
      let previewTimedOut = false
      let previewTimer: ReturnType<typeof setTimeout> | undefined

      // Registered BEFORE the race: a timeout rejection jumps straight to the
      // outer catch, so any registration after the await is unreachable in
      // exactly the case it exists for. If the native start finishes after we
      // already gave up, the camera would run with no owner (battery/thermal
      // drain, and the wedged session can break the next arm attempt) — tear
      // it down, but only if no newer arm has started since (generation
      // check; the newer arm owns the camera now).
      void previewPromise.then(
        () => {
          if (previewTimedOut && previewArmGenerationRef.current === armGeneration) {
            telemetry.warn(
              'live:preview_late_recovery',
              'Preview started after timeout; tearing down unowned camera session',
            )
            livePublisher.cancel().catch(() => {})
          }
        },
        () => {},
      )

      try {
        await Promise.race([
          previewPromise,
          new Promise<never>((_, reject) => {
            previewTimer = setTimeout(() => {
              previewTimedOut = true
              telemetry.error('live:preview_timeout', 'Camera preview did not start in time', {
                timeoutMs: PREVIEW_TIMEOUT_MS,
              })
              reject(new Error('Camera preview timed out'))
            }, PREVIEW_TIMEOUT_MS)
          }),
        ])
      } finally {
        clearTimeout(previewTimer)
      }

      ownsPreviewRef.current = true
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
    state$,
  ])

  const liveProvisionArgs = {
    respondToBondfireId: respondTo,
    campId: effectiveCampId,
    personalCamp: !respondTo && isPersonalCamp ? true : undefined,
    tags: selectedCampTags,
    title: !respondTo
      ? getDefaultBondfireTitle(currentUser, selectedCamp?.name) || undefined
      : undefined,
    draftBondfireId: !respondTo && isPersonalCamp ? draftBondfireId : undefined,
  }
  const liveProvisionArgsRef = useRef(liveProvisionArgs)
  liveProvisionArgsRef.current = liveProvisionArgs
  const provisionArgsKey = JSON.stringify(liveProvisionArgs)

  // Eagerly provision the Mux stream while the user frames the shot, so the
  // record tap only has to open the RTMP connection (the provision leg —
  // Convex action + Mux API — comes off the tap's critical path). Provisioned
  // records are created pending:true so nothing is user-visible until video
  // actually flows (markBondfireLive at tap, live_stream.active webhook as
  // the authoritative backstop). Abandoned sessions are released by the
  // existing blur/unmount/expiry cancel paths, the post-provision check
  // below, and ultimately the server's 5-minute pending cap + stale sweep.

  useEffect(() => {
    if (phase !== 'pre_connected' || !isFocused || !isAppActive) {
      return
    }
    if (
      livePublisherRef.current.hasProvisionedIngest() &&
      provisionedArgsKeyRef.current === provisionArgsKey
    ) {
      return
    }
    const attempt = ++provisionAttemptRef.current
    const args = liveProvisionArgsRef.current
    const argsKey = provisionArgsKey
    const chain = (provisionInFlightRef.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (attempt !== provisionAttemptRef.current) return
        if (recordingStore$.phase.peek() !== 'pre_connected') return
        const publisher = livePublisherRef.current
        // Replace a session provisioned under different camp/tags/title.
        if (publisher.hasProvisionedIngest()) {
          const discarded = await publisher.discardProvision('provision_args_changed')
          if (!discarded) return
          provisionedArgsKeyRef.current = null
          provisionedRecordTypeRef.current = null
        }
        if (attempt !== provisionAttemptRef.current) return
        if (recordingStore$.phase.peek() !== 'pre_connected') return
        try {
          const liveStream = await livePublisherRef.current.provision({ ...args, pending: true })
          provisionedArgsKeyRef.current = argsKey
          provisionedRecordTypeRef.current = liveStream.recordType
          // The user left pre-connect while the provision round-trip was in
          // flight (blur/unmount cancel ran before there was a session to
          // cancel) — release it now instead of waiting for the reaper.
          if (recordingStore$.phase.peek() !== 'pre_connected') {
            provisionedArgsKeyRef.current = null
            provisionedRecordTypeRef.current = null
            await livePublisherRef.current.discardProvision('preconnect_abandoned')
          }
        } catch (error) {
          // Best-effort: the record tap falls back to the full
          // provision+connect path, so a failure here costs latency, not UX.
          telemetry.warn('live:preconnect', 'Eager provision failed; tap will fall back', {
            error: String(error),
          })
        }
      })
      .finally(() => {
        if (provisionInFlightRef.current === chain) {
          provisionInFlightRef.current = null
        }
      })
    provisionInFlightRef.current = chain
  }, [phase, isFocused, isAppActive, provisionArgsKey])

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

    // Double-tap guard: 'creating' no longer implies a tap-initiated start
    // (background eager provisions use it too), so the tap needs its own flag.
    if (state$.isTapStarting.peek()) {
      return
    }

    const initialCamera =
      recordingStore$.facing.get() === 'back' ? ('back' as const) : ('front' as const)

    liveTerminalRecoveryFiredRef.current = false
    state$.isTapStarting.set(true)

    try {
      // Wait out an in-flight eager provision instead of racing it with a
      // second createLiveStream — the server refuses concurrent sessions.
      if (provisionInFlightRef.current) {
        await provisionInFlightRef.current.catch(() => {})
      }

      const publisher = livePublisherRef.current
      const expectedArgs = liveProvisionArgsRef.current
      const expectedArgsKey = JSON.stringify(expectedArgs)
      const canUseProvisioned =
        publisher.hasProvisionedIngest() && provisionedArgsKeyRef.current === expectedArgsKey

      try {
        if (canUseProvisioned) {
          // Fast path: the stream was provisioned during framing, so the tap
          // only opens the RTMP connection.
          await publisher.connect({ initialCamera })
          // Flip the pending record live for immediate feed visibility. Fire
          // and forget — the live_stream.active webhook is the authoritative
          // backstop for both record types.
          const provisionedRecordId = livePublishStore$.recordId.get()
          if (provisionedRecordTypeRef.current === 'bondfire' && provisionedRecordId) {
            markBondfireLive({ bondfireId: provisionedRecordId as Id<'bondfires'> }).catch(
              (error) => {
                telemetry.warn('live:start', 'markBondfireLive failed; webhook will resolve it', {
                  recordId: provisionedRecordId,
                  error: String(error),
                })
              },
            )
          }
        } else {
          // Fallback: eager provisioning failed, was reaped, or its args went
          // stale between framing and tap. Release any mismatched session first
          // so createLiveStream's concurrent-session guard doesn't refuse.
          if (publisher.hasProvisionedIngest()) {
            const discarded = await publisher.discardProvision('stale_at_record_tap')
            if (!discarded) {
              throw new Error('Could not replace the outdated live session')
            }
          }
          provisionedArgsKeyRef.current = null
          provisionedRecordTypeRef.current = null
          await publisher.start({ ...expectedArgs, initialCamera })
        }
        ownsPreviewRef.current = false
      } catch (error) {
        logRecordingError(error)
        Alert.alert('Recording Failed', getUserFacingErrorMessage(parseError(error)))
        return
      }

      state$.showInviteSheet.set(false)
      recordingStore$.recordingDuration.set(0)
      recordingActions.setPhase('recording', 'live record tap')
    } finally {
      state$.isTapStarting.set(false)
    }
  }, [logRecordingError, markBondfireLive, state$])

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
      if (result.recordingStarted === false) {
        recordingStore$.preConnectFailed.set(true)
        recordingStore$.previewExpired.set(false)
        recordingStore$.progressStage.set("Recording didn't start")
        recordingActions.setPhase('idle', 'live stop before mux active')
        recordingStore$.videoUri.set(null)
        state$.showInviteSheet.set(false)
        Alert.alert(
          "Recording didn't start",
          respondTo
            ? "Mux never confirmed that video was flowing, so we didn't save a broken response. Please try again."
            : "Mux never confirmed that video was flowing, so we didn't save a broken Bondfire. Please try again.",
        )
        return
      }

      // The recording is captured the moment the publisher stops. Mux finalizes
      // the VOD on RTMP disconnect and the asset.ready webhook saves it, so
      // always advance to the completion/processing screen rather than resetting
      // to idle (which read as "recording lost").
      recordingActions.setPhase('completion', 'live stop succeeded')
      recordingStore$.videoUri.set('live')
      state$.showInviteSheet.set(false)

      if (result.backendNotified === false) {
        // Stopped while offline / the backend was unreachable, so we couldn't
        // confirm the finalize from here. Mux still finalizes the recording it
        // already captured from the live stream — set expectations so the
        // creator doesn't think the recording vanished.
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
  }, [livePublisher, liveStatus, logRecordingError, respondTo, state$])

  // Thermal mitigation — RTMP encoding + camera generates significant heat.
  // Polls thermal state every 10s and reacts by reducing encoder load before
  // the OS kills the app. The native modules also have a safety-net auto-stop
  // at critical level, but JS mitigation fires first to give a graceful stop.
  // State lives in refs because the effect's deps include callbacks whose
  // identity changes with liveStatus — a re-run must not re-fire telemetry or
  // re-apply encoder settings mid-recording.
  useEffect(() => {
    if (phase !== 'recording') {
      thermalLastLevelRef.current = -1
      thermalAppliedLevelRef.current = 0
      thermalCoolPollsRef.current = 0
      thermalStoppingRef.current = false
      thermalCheckInFlightRef.current = false
      state$.thermalWarning.set(false)
      return
    }

    const applyQuality = async (level: number) => {
      const target = THERMAL_QUALITY_LADDER[level]
      if (!target) return
      // The publisher composes this thermal ceiling with the current network
      // ceiling and coalesces concurrent updates before touching the encoder.
      const configured = await livePublisher.setThermalQuality(target.bitrate, target.fps)
      if (!configured) return
      thermalAppliedLevelRef.current = level
      state$.thermalWarning.set(level >= 2)
      telemetry.info('live:thermal_mitigation', 'Adjusting quality for thermal state', {
        level,
        thermalBitrateCap: target.bitrate,
        fps: target.fps,
        configuredVideoBitrate: configured.configuredVideoBitrate,
        configuredFps: configured.configuredFps,
        fpsChangeSupported: configured.fpsChangeSupported,
      })
    }

    const checkThermal = async () => {
      if (thermalStoppingRef.current || thermalCheckInFlightRef.current) return
      thermalCheckInFlightRef.current = true
      try {
        const thermalState = await livePublisher.getThermalState?.()
        if (!thermalState) return
        const { level } = thermalState

        if (level !== thermalLastLevelRef.current) {
          thermalLastLevelRef.current = level
          telemetry.breadcrumb('live:thermal', {
            level,
            levelName: thermalState.levelName,
            rawLevel: thermalState.rawLevel,
            platform: Platform.OS,
            sessionId: livePublishStore$.sessionId.peek(),
          })
        }

        // Unknown/unsupported on this device — telemetry only, no mitigation.
        if (level < 0) return

        if (level >= 3) {
          // critical — graceful auto-stop to save the recording
          thermalStoppingRef.current = true
          telemetry.warn(
            'live:thermal_auto_stop',
            'Thermal level critical — auto-stopping to save recording',
            {
              level,
              levelName: thermalState.levelName,
              sessionId: livePublishStore$.sessionId.peek(),
              recordId: livePublishStore$.recordId.peek(),
            },
          )
          state$.thermalWarning.set(false)
          void stopLiveRecording()
          return
        }

        const applied = thermalAppliedLevelRef.current
        if (level > applied) {
          // Heating up — step quality down immediately.
          thermalCoolPollsRef.current = 0
          await applyQuality(level)
        } else if (level < applied) {
          // Cooling — step back up only after sustained cooler readings so an
          // oscillating thermal level doesn't flap the encoder settings.
          thermalCoolPollsRef.current += 1
          if (thermalCoolPollsRef.current >= THERMAL_STEP_UP_POLLS) {
            thermalCoolPollsRef.current = 0
            await applyQuality(level)
          }
        } else {
          thermalCoolPollsRef.current = 0
        }
      } catch (error) {
        // A missing/stale native build or rejected encoder update must be
        // visible in telemetry; otherwise a failed mitigation looks identical
        // to a successful one until the device reaches critical.
        telemetry.warn('live:thermal_mitigation_failed', 'Failed to apply thermal mitigation', {
          error: String(error),
          level: thermalLastLevelRef.current,
          platform: Platform.OS,
          sessionId: livePublishStore$.sessionId.peek(),
        })
      } finally {
        thermalCheckInFlightRef.current = false
      }
    }

    const interval = setInterval(checkThermal, THERMAL_POLL_INTERVAL_MS)
    checkThermal() // Check immediately

    return () => {
      clearInterval(interval)
    }
  }, [
    phase,
    livePublisher.setThermalQuality,
    livePublisher.getThermalState,
    stopLiveRecording,
    state$,
  ])

  // Auto-stop at the recording duration cap.
  // NOTE: the pre-refactor create screen routed this through the legacy
  // stopRecording() first whenever phase === 'recording', which in live mode
  // finalized zero segments and surfaced "Recording Failed". The live screen
  // now stops the live publisher directly.
  useEffect(() => {
    if (!effectiveMaxRecordingSeconds || recordingDuration < effectiveMaxRecordingSeconds) {
      return
    }
    // Ownership gate (see hasProvisionedIngest): only the instance that owns the
    // current live session may stop it. A dormant duplicate create screen reads
    // the same module-global phase/liveStatus and would otherwise tear down the
    // active instance's recording.
    if (!livePublisher.hasProvisionedIngest()) {
      return
    }

    if (phase === 'recording' || liveStatus === 'live' || liveStatus === 'reconnecting') {
      void stopLiveRecording()
    }
  }, [
    liveStatus,
    phase,
    recordingDuration,
    effectiveMaxRecordingSeconds,
    stopLiveRecording,
    livePublisher,
  ])

  const cancelLiveRecording = useCallback(() => {
    if (cancelInFlightRef.current) {
      return cancelInFlightRef.current
    }

    const cancelPromise = (async () => {
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
        ownsPreviewRef.current = false
        livePublishActions.reset()
        recordingActions.setPhase('idle', 'live cancel')
        recordingStore$.videoUri.set(null)
        state$.showInviteSheet.set(false)
        cancelInFlightRef.current = null
      }
    })()

    cancelInFlightRef.current = cancelPromise
    return cancelPromise
  }, [livePublisher, logRecordingError, state$])

  useEffect(() => {
    if (isFocused && isAppActive) {
      // Focus/active regained — abort any pending blur teardown. Clearing here
      // is what absorbs a flapping useIsFocused() and breaks the otherwise
      // infinite arm/cancel loop.
      if (blurCancelTimeoutRef.current) {
        clearTimeout(blurCancelTimeoutRef.current)
        blurCancelTimeoutRef.current = null
      }
      return
    }

    const currentRecordingState = recordingStore$.phase.get()
    const ownsLiveSession = livePublisher.hasProvisionedIngest()
    const ownsPreview = currentRecordingState === 'pre_connected' && ownsPreviewRef.current

    // Ownership gate: a dormant duplicate of this screen is also `!isFocused`.
    // Only the instance that owns the current live session or preview may tear
    // it down here.
    if (!ownsLiveSession && !ownsPreview) {
      return
    }

    if (currentRecordingState === 'recording' || currentRecordingState === 'stopping') {
      if (!ownsLiveSession) {
        return
      }
      void stopLiveRecording()
      return
    }

    if (currentRecordingState === 'pre_connected' && !isFocused) {
      // Debounce: only tear down the provisioned session if the blur persists.
      // A brief navigation-transition blur must not cancel, or the auto-arm
      // effect rebuilds the session on the next render and we ping-pong
      // forever (provision/cancel storm against Mux). Re-check state at fire
      // time so a refocus or a phase change between scheduling and firing is a
      // no-op. (App-background teardown is handled separately on a 2-min timer.)
      if (!blurCancelTimeoutRef.current) {
        blurCancelTimeoutRef.current = setTimeout(() => {
          blurCancelTimeoutRef.current = null
          if (recordingStore$.phase.get() === 'pre_connected' && !state$.isFocused.get()) {
            void cancelLiveRecording()
          }
        }, 1500)
      }
    }
  }, [cancelLiveRecording, isAppActive, isFocused, livePublisher, state$, stopLiveRecording])

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
      //
      // iOS note: AVCaptureSession reconfiguration (beginConfiguration / commitConfiguration)
      // inside HaishinKit's MediaMixer.attachVideo can hang during active RTMP encoding on
      // some devices. The promise may never resolve or reject, leaving the UI in a silent
      // no-op state. We wrap the call with a 5-second timeout so the user gets feedback
      // instead of a frozen button.
      if (liveCameraSwapInFlightRef.current) {
        telemetry.info('live:swap_camera_skipped', 'Camera swap already in progress', {
          phase: currentRecordingState,
          liveStatus,
        })
        return
      }

      liveCameraSwapInFlightRef.current = true
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Camera swap timed out')),
          LIVE_CAMERA_SWAP_TIMEOUT_MS,
        )
      })
      const swapPromise = livePublisher.swapCamera()

      telemetry.info('live:swap_camera', 'Camera swap requested', {
        phase: currentRecordingState,
        liveStatus,
      })

      void Promise.race([swapPromise, timeoutPromise])
        .then(() => {
          recordingStore$.facing.set(recordingStore$.facing.get() === 'back' ? 'front' : 'back')
          telemetry.info('live:swap_camera_ok', 'Camera swap succeeded', {
            phase: currentRecordingState,
            liveStatus,
          })
        })
        .catch((error) => {
          const errObj = error instanceof Error ? error : new Error(String(error))
          logRecordingError(error)
          telemetry.warn('live:swap_camera_failed', 'Camera swap failed', {
            error: errObj.message,
            phase: currentRecordingState,
            liveStatus,
          })
          const errorInfo = parseError(errObj)
          const message = errObj.message.includes('timed out')
            ? LIVE_CAMERA_SWAP_TIMEOUT_MESSAGE
            : getUserFacingErrorMessage(errorInfo)
          Alert.alert('Switch Camera Failed', message)
        })
        .finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId)
          }
          liveCameraSwapInFlightRef.current = false
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
      ? 'Sparking your own Bondfire is a Plus feature. Free members can respond to any fire.'
      : !respondTo && !isPersonalCamp && isCampListLoaded && !selectedCamp
        ? 'Choose a Camp before sparking a Bondfire.'
        : needsTradeTag
          ? 'This camp asks each spark to be a Need or an Offer.'
          : null

  useEffect(() => {
    // Gate arming on the same focus/active signal the blur-teardown effect
    // uses. If they keyed off different sources, one could arm while the other
    // tears down and the screen would oscillate. (startLivePreConnect also
    // re-checks state$ internally as a belt-and-suspenders guard.)
    if (!shouldRenderCamera || phase !== 'idle' || preConnectFailed || !isFocused || !isAppActive) {
      return
    }

    void startLivePreConnect()
  }, [preConnectFailed, phase, shouldRenderCamera, startLivePreConnect, isFocused, isAppActive])

  // Reconcile a stale non-response pre-connect after a remount. The recording
  // phase is module-global and survives this screen unmounting/remounting, but
  // the ingest credentials live in the useLivePublisher instance (a ref). A
  // pre-connect abandoned by navigating away without recording leaves
  // phase==='pre_connected' with no local ingest on the next mount: tapping
  // record dead-ends on "No provisioned live stream to connect" (and the
  // eagerly-provisioned pending bondfire shows viewers "Recording failed").
  // recordId still being set is why the create-router recovery (keyed on a
  // missing recordId) can't catch this. Tear the orphan down — cancelLive-
  // Recording also deletes the pending bondfire + Mux stream server-side — so
  // the auto-arm re-provisions a fresh, recordable session.
  useEffect(() => {
    if (phase !== 'pre_connected') {
      staleReconcileFiredRef.current = false
      return
    }
    // Only the focused instance may reconcile. The Spark tab pushes a `create`
    // route while the tab's own `create` stays mounted underneath, so two
    // instances coexist. They share the module-global phase but each has its
    // own ingest ref, so an unfocused instance always sees "no local ingest"
    // and would cancel the focused instance's freshly-provisioned session — an
    // infinite provision/cancel loop ("Preparing camera…"). Gating on focus
    // keeps the dormant instance from fighting the live one while still letting
    // a genuine remount (one focused instance) recover its orphaned ingest.
    if (!isFocused || !isAppActive) {
      return
    }
    if (respondTo || staleReconcileFiredRef.current || preConnectInFlightRef.current) {
      return
    }
    if (livePublisher.hasProvisionedIngest()) {
      return
    }
    if (!livePublishStore$.sessionId.peek() && !livePublishStore$.recordId.peek()) {
      return
    }
    const status = livePublishStore$.status.peek()
    if (status === 'connecting' || status === 'live' || status === 'reconnecting') {
      return
    }
    staleReconcileFiredRef.current = true
    telemetry.warn(
      'create:preconnect',
      'Pre-connected with no local ingest (orphaned by remount); recovering',
      { isPersonalCamp, status },
    )
    void cancelLiveRecording()
  }, [phase, respondTo, isPersonalCamp, isFocused, isAppActive, livePublisher, cancelLiveRecording])

  // Clean up an abandoned pre-connect after 2 minutes in the background.
  useEffect(() => {
    if (phase !== 'pre_connected') {
      return
    }
    // Ownership gate: cancel either a provisioned session or a preview-only
    // pre-connect owned by this screen.
    if (!livePublisher.hasProvisionedIngest() && !ownsPreviewRef.current) {
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
  }, [cancelLiveRecording, isAppActive, phase, livePublisher])

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
    // Ownership gate: expire either a provisioned session or a preview-only
    // pre-connect owned by this screen.
    if (!livePublisher.hasProvisionedIngest() && !ownsPreviewRef.current) {
      return
    }

    const timeout = setTimeout(() => {
      recordingStore$.previewExpired.set(true)
      recordingStore$.preConnectFailed.set(true)
      void cancelLiveRecording()
    }, 240_000)

    return () => clearTimeout(timeout)
  }, [cancelLiveRecording, phase, livePublisher])

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
    if (liveTerminalRecoveryFiredRef.current) {
      return
    }
    // Ownership gate (see hasProvisionedIngest): only the session owner finalizes.
    if (!livePublisher.hasProvisionedIngest()) {
      return
    }

    liveTerminalRecoveryFiredRef.current = true

    const startedAt = livePublishStore$.startedAt.peek()
    const durationMs = startedAt ? Date.now() - startedAt : undefined
    // everHadThroughput === false means every measured stats sample was ~zero:
    // the pipeline never sent Mux a frame regardless of how long the REC
    // screen sat there. Finalizing would upload nothing and leave an errored
    // asset + stale session for the reaper, so cancel and let the user retry
    // (production telemetry shows immediate retries succeed). Bounded by
    // NEVER_STARTED_CANCEL_MAX_MS because cancel is destructive — see the
    // constant's comment.
    const neverStarted =
      livePublishStore$.everHadThroughput.peek() === false &&
      durationMs !== undefined &&
      durationMs < NEVER_STARTED_CANCEL_MAX_MS
    if ((durationMs !== undefined && durationMs < EARLY_LIVE_DROP_MS) || neverStarted) {
      telemetry.warn('live:early_drop', 'Live stream dropped before sufficient video data', {
        reason: liveStatus,
        durationMs,
        neverStarted,
        sessionId: livePublishStore$.sessionId.peek(),
        recordId: livePublishStore$.recordId.peek(),
      })
      recordingStore$.preConnectFailed.set(true)
      recordingStore$.previewExpired.set(false)
      recordingStore$.progressStage.set("Recording didn't start")
      void cancelLiveRecording()
      return
    }

    // For a later drop, don't show an alert — the status transition is visible
    // in the UI and the completed upload will show whatever was captured.
    if (liveStatus === 'endpoint_closed') {
      telemetry.info(
        'live:network_finalize',
        'Network changed during recording — finalizing partial recording',
        {
          reason: liveStatus,
          durationMs,
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
        },
      )
    }
    void stopLiveRecording()
  }, [liveStatus, phase, stopLiveRecording, livePublisher, cancelLiveRecording])

  // Network connectivity listener — logs telemetry breadcrumbs during active
  // recording. The native NWPathMonitor handles the actual finalize (emitting
  // `.endpointClosed`), so this listener is observational only and does not
  // duplicate the stop logic.
  useEffect(() => {
    if (phase !== 'recording' || !livePublisher.hasProvisionedIngest()) {
      return
    }

    let wasOnline = true
    const subscription = Network.addNetworkStateListener((state) => {
      const isOffline = state.isConnected === false || state.isInternetReachable === false
      const isOnline = state.isConnected === true && state.isInternetReachable !== false

      if (isOffline && wasOnline) {
        telemetry.info('live:network_dropped', 'Network dropped during live recording', {
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
        })
        wasOnline = false
      } else if (isOnline && !wasOnline) {
        telemetry.info('live:network_restored', 'Network restored during live recording', {
          sessionId: livePublishStore$.sessionId.peek(),
          recordId: livePublishStore$.recordId.peek(),
        })
        wasOnline = true
      }
    })

    return () => {
      subscription.remove()
    }
  }, [phase, livePublisher])

  const cancelLiveRecordingRef = useRef(cancelLiveRecording)
  useEffect(() => {
    cancelLiveRecordingRef.current = cancelLiveRecording
  }, [cancelLiveRecording])

  const stopLiveRecordingRef = useRef(stopLiveRecording)
  useEffect(() => {
    stopLiveRecordingRef.current = stopLiveRecording
  }, [stopLiveRecording])

  // Track session ownership in a ref so the mount-scoped unmount cleanup below
  // (which captures nothing reactively) can tell whether THIS instance owns the
  // live session at teardown time.
  const ownsLiveSessionRef = useRef(false)
  useEffect(() => {
    ownsLiveSessionRef.current = livePublisher.hasProvisionedIngest()
  })

  // Mount-scoped unmount cleanup: cancel a provisioned-but-unstarted session.
  // Uses refs/observables so changing callback identities can't fire this early.
  useEffect(() => {
    return () => {
      // Ownership gate (see hasProvisionedIngest): a dormant duplicate of this
      // screen unmounting must not cancel the active instance's session.
      if (!ownsLiveSessionRef.current && !ownsPreviewRef.current) {
        return
      }
      const currentRecordingState = recordingStore$.phase.get()
      if (currentRecordingState === 'pre_connected') {
        void cancelLiveRecordingRef.current()
        return
      }
      if (currentRecordingState === 'idle' && livePublishStore$.recordId.get()) {
        // Phase idle with a live session still provisioned means something
        // reset the flow out from under an active session (a watchdog reset,
        // a store bug). If the stream ever carried video, cancel would
        // server-side delete real footage — finalize instead so Mux saves
        // the VOD and the user keeps their recording. Cancel remains correct
        // for never-started sessions (nothing to save).
        if (livePublishStore$.everHadThroughput.get() === true) {
          telemetry.warn(
            'live:orphan_finalize',
            'Idle phase with a live session that had throughput — finalizing instead of cancelling',
            {
              sessionId: livePublishStore$.sessionId.get(),
              recordId: livePublishStore$.recordId.get(),
              liveStatus: livePublishStore$.status.get(),
            },
          )
          void stopLiveRecordingRef.current()
          return
        }
        void cancelLiveRecordingRef.current()
      }
    }
  }, [])

  const isPreConnected = phase === 'pre_connected'
  const isLiveRecording = phase === 'recording'
  // 'creating' during pre_connected is a *background* eager provision — the
  // camera is up and the record button must stay live (the tap path waits out
  // the in-flight provision itself). Tap-initiated starts are tracked by
  // isTapStarting instead.
  const isLiveBusy =
    isTapStarting ||
    (liveStatus === 'creating' && !isPreConnected) ||
    liveStatus === 'connecting' ||
    liveStatus === 'stopping'
  const statusLabel =
    isTapStarting || liveStatus === 'connecting'
      ? 'Starting...'
      : liveStatus === 'stopping'
        ? 'Saving...'
        : liveStatus === 'creating' && !isPreConnected
          ? 'Preparing camera...'
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
  // Safety-net upgrade block (M2): a free user reached the camera via a path
  // we didn't intercept upstream (stale deep link, notification, legacy
  // affordance). Show a real "View Plans" CTA instead of dead-ending. This is
  // NOT a primary flow — Feed header and camp detail open the paywall directly.
  const showUpgradeBlock = showPreConnectBlocked && !respondTo && !canCreate
  const showBusySpinner =
    !isLiveRecording &&
    !showPreConnectError &&
    !showPreConnectBlocked &&
    (isLiveBusy || !isPreConnected)

  // Telemetry: a free user hit the safety-net upgrade wall on the live screen.
  useEffect(() => {
    if (showUpgradeBlock) {
      freeUpgradeActions.trackCtaShown('live_blocked')
    }
  }, [showUpgradeBlock])

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
      {shouldRenderCamera ? (
        <>
          <LivePublisherView style={{ flex: 1 }} />

          {isLiveRecording && liveStatus === 'endpoint_closed' && (
            <YStack
              position="absolute"
              top={120}
              left={0}
              right={0}
              alignItems="center"
              pointerEvents="none"
            >
              <YStack
                paddingHorizontal={16}
                paddingVertical={8}
                borderRadius={16}
                backgroundColor="rgba(31, 32, 35, 0.85)"
              >
                <Text color="white" fontSize={14} fontWeight="700">
                  Network changed — saving your recording...
                </Text>
              </YStack>
            </YStack>
          )}

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

          {/* Viewer presence stack — below the X button, left side */}
          {liveStatus === 'live' && (
            <ViewerPresenceStack liveViewers={liveViewers} style={{ top: 110, left: 20 }} />
          )}

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
                  {previewExpired
                    ? 'Camera timed out'
                    : progressStage === "Recording didn't start"
                      ? "Recording didn't start"
                      : "Camera couldn't start"}
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
                {showUpgradeBlock && (
                  <YStack alignItems="center" gap={12}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="View subscription plans"
                      onPress={() => freeUpgradeActions.pressPaywallCta('live_blocked')}
                    >
                      <YStack
                        paddingHorizontal={24}
                        paddingVertical={10}
                        borderRadius={20}
                        backgroundColor={'$primary'}
                      >
                        <Text color={'$color'} fontWeight="800">
                          View Plans
                        </Text>
                      </YStack>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Learn what you can do for free"
                      onPress={() => freeUpgradeActions.openExplainer('live_blocked')}
                    >
                      <Text color={'$color'} fontSize={14} textDecorationLine="underline">
                        What can I do for free?
                      </Text>
                    </Pressable>
                  </YStack>
                )}
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

          {thermalWarning && (
            <XStack
              position="absolute"
              top={60}
              left={20}
              right={20}
              justifyContent="center"
              backgroundColor="rgba(180, 100, 0, 0.85)"
              borderRadius={12}
              paddingVertical={8}
              paddingHorizontal={16}
              zIndex={10}
            >
              <Text color="white" fontSize={13} fontWeight="600">
                Device getting warm — reducing quality to protect your recording
              </Text>
            </XStack>
          )}

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
              mode={isPersonalCamp ? 'personal-bondfire' : 'bondfire'}
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
