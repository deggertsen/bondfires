import {
  appActions,
  appStore$,
  cancelProcessing,
  livePublishActions,
  livePublishStore$,
  recordingActions,
  recordingStore$,
  resumePendingUploads,
  telemetry,
  useAppThemeColors,
  useSubscription,
} from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState, Platform, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { CompletionScreen } from '../../components/CompletionScreen'
import { CampPickerScreen } from '../../components/create/CampPickerScreen'
import { LegacyRecordScreen } from '../../components/create/LegacyRecordScreen'
import { LiveRecordScreen } from '../../components/create/LiveRecordScreen'
import type { TradeTag } from '../../components/create/shared'
import { goBackOrReplace } from '../../lib/navigation'
import { routes } from '../../lib/routes'
import { BondfireLivePublisher } from '../../modules/bondfire-live-publisher'

export default function CreateScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const { campId, respondTo, personalCamp } = useLocalSearchParams<{
    campId?: string
    respondTo?: string
    personalCamp?: string
  }>()
  const isPersonalCamp = personalCamp === '1'
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()

  // Subscription gating for Spark/create actions
  const { canCreate, showPaywall } = useSubscription()

  const uploadStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Starts false (not isFocused) so a fresh mount counts as "returning":
  // initializing to true permanently skipped the completion-reset effect when
  // this screen remounted while the recording store held stale state.
  const wasFocusedRef = useRef(false)
  const personalCreateStartedAtRef = useRef<number | null>(null)

  // TEMPORARY mount/unmount diagnostic — remove after the camera-freeze /
  // remount-loop regression is confirmed fixed. A stable per-instance id lets
  // us tell a single screen *remounting* (same id, alternating mount/unmount)
  // apart from *duplicate* screens (two ids alive at once), and the route-name
  // snapshot reveals whether the navigation stack holds more than one create.
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 8))
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only diagnostic
  useEffect(() => {
    const mountId = mountIdRef.current
    let routeNames: string | undefined
    let routeCount: number | undefined
    try {
      const navState = (
        navigation as { getState?: () => { routes?: { name: string }[] } }
      ).getState?.()
      routeCount = navState?.routes?.length
      routeNames = navState?.routes?.map((r) => r.name).join(',')
    } catch {
      // navigation state not available; ignore
    }
    telemetry.info('create:mount', 'Create screen mounted', { mountId, routeCount, routeNames })
    return () => {
      telemetry.info('create:unmount', 'Create screen unmounted', { mountId })
    }
    // Mount-only diagnostic; navigation state is read opportunistically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const state$ = useObservable({
    isAppActive: AppState.currentState === 'active',
    isFocused: isFocused,
    selectedCampId: null as Id<'camps'> | null,
    promptCampId: null as Id<'camps'> | null,
    promptDismissed: false,
    tradeTag: null as TradeTag | null,
  })

  const isAppActive = useValue(state$.isAppActive)
  const selectedCampId = useValue(state$.selectedCampId)
  const promptDismissed = useValue(state$.promptDismissed)
  const tradeTag = useValue(state$.tradeTag)
  const recordingPhase = useValue(recordingStore$.phase)
  const videoUri = useValue(recordingStore$.videoUri)
  const isLivePublisherAvailable = useValue(recordingStore$.isLivePublisherAvailable)
  const livePublishEnabled = useValue(appStore$.preferences.livePublishEnabled)
  const currentCampId = useValue(appStore$.currentCampId)
  const shouldUseLivePublish = livePublishEnabled && isLivePublisherAvailable
  const liveRecordId = useValue(livePublishStore$.recordId)

  // Invariant: on the live create flow (not a response), the bondfire row is
  // provisioned the moment recording starts (livePublisher.start), so reaching
  // 'completion' guarantees a recordId. If we ever hit 'completion' here without
  // one, nothing was actually created — showing the degraded, un-shareable
  // completion screen would be a lie. Detect that state so we can recover to the
  // camera instead of rendering it. (Pre-connect, which precedes recording, is
  // preview-only and has no recordId yet — see the note below.)
  const isLiveBondfireCompletion =
    recordingPhase === 'completion' && !!videoUri && shouldUseLivePublish && !respondTo
  const liveCompletionMissingRecord = isLiveBondfireCompletion && !liveRecordId

  // NOTE: There is intentionally no "pre_connected must have a recordId" guard
  // here. Pre-connect is preview-only for every flow (response AND new
  // Bondfire): startLivePreConnect only starts the native camera preview and
  // flips the phase to 'pre_connected'; the Mux stream + bondfire row are
  // provisioned lazily in startLiveRecording (livePublisher.start) at record
  // tap. So a non-response 'pre_connected' legitimately has no recordId until
  // the user taps record — an earlier guard keyed on a missing recordId was
  // true for every new-Bondfire pre-connect and fought the auto-arm in an
  // infinite reset/re-arm loop ("Preparing camera…" forever) once live publish
  // became available. The record tap can't dead-end either: start() always
  // provisions fresh and never relies on a pre-provisioned ingest.

  const createMuxDirectUpload = useAction(api.videos.createMuxDirectUpload)
  const getMuxUploadStatus = useAction(api.videos.getMuxUploadStatus)
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
  const needsTradeTag =
    !respondTo && selectedCamp?.rules.advisory.requiresTradeTags === true && tradeTag === null

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
  }, [effectiveCampId, respondTo, selectedCamp, state$])

  // Cleanup on unmount. Reset the recording flow store so stale state can't
  // leak into the next visit to this route.
  useEffect(() => {
    return () => {
      if (uploadStartTimeoutRef.current) {
        clearTimeout(uploadStartTimeoutRef.current)
        uploadStartTimeoutRef.current = null
      }
      cancelProcessing()
      recordingActions.reset()
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

    if (recordingStore$.phase.get() === 'completion') {
      recordingActions.resetFlow('returned to create tab after completion')
      // Clear respondTo param so user can create a new spark instead of responding.
      if (respondTo) {
        router.replace(routes.create)
      }
    }
  }, [isFocused, respondTo, router])

  // Recover from an inconsistent live completion: phase says 'completion' but no
  // bondfire was provisioned. This shouldn't happen (provisioning precedes
  // recording), but if stale state ever produces it, reset to idle so the
  // pre-connect re-provisions and the user can record again — rather than being
  // stranded on a completion screen with no title to edit and nothing to share.
  useEffect(() => {
    // Only the focused instance recovers. The Spark tab pushes a `create` route
    // over the tab's own `create`, so two instances share the module-global
    // recording phase; letting the unfocused one reset state fights the live
    // instance (an infinite recover/re-arm loop).
    if (!liveCompletionMissingRecord || !isFocused) {
      return
    }
    telemetry.warn(
      'create:completion',
      'Live completion reached without a provisioned bondfire id; recovering to idle',
      { isPersonalCamp },
    )
    livePublishActions.reset()
    recordingActions.resetFlow('live completion missing record id')
  }, [liveCompletionMissingRecord, isPersonalCamp, isFocused])

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
          recordingStore$.isLivePublisherAvailable.set(isAvailable)
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
          recordingStore$.isLivePublisherAvailable.set(false)
        }
      })

    return () => {
      isCancelled = true
    }
    // Include permission status deps so telemetry reflects latest state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPermission?.status, micPermission?.status])

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
        isCameraReady: recordingStore$.isCameraReady.get(),
        recordingState: recordingStore$.phase.get(),
      })
    },
    [cameraPermission?.status, micPermission?.status, state$],
  )

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

  // Resume pending uploads after the user leaves the screen. (Split out of the
  // legacy camera-teardown-on-blur effect, whose teardown half now lives in
  // LegacyRecordScreen; scheduling stays here because uploads are shared.)
  //
  // Drain regardless of the live gate. Fallback uploads can exist even when the
  // live path is currently available, and leaving them scheduled-only makes
  // stale "Queued..." profile tasks linger indefinitely. No-op when empty.
  useEffect(() => {
    if (!isFocused || !isAppActive) {
      if (!isFocused) {
        schedulePendingUploads()
      }
    } else {
      clearUploadStartTimeout()
    }
  }, [clearUploadStartTimeout, isAppActive, isFocused, schedulePendingUploads])

  const handleCampConfirmed = useCallback(
    (selectedId: Id<'camps'>) => {
      state$.selectedCampId.set(selectedId)
      state$.tradeTag.set(null)
      appActions.setCurrentCampId(selectedId)
    },
    [state$],
  )

  const handleSelectTradeTag = useCallback(
    (tag: TradeTag) => {
      state$.tradeTag.set(tag)
    },
    [state$],
  )

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  const shouldRenderCamera =
    cameraPermission?.granted && micPermission?.granted && isFocused && isAppActive

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
      <CampPickerScreen
        camps={camps}
        sortedCamps={sortedCamps}
        personalCampDoc={personalCampDoc}
        joinCamp={joinCamp}
        onCampConfirmed={handleCampConfirmed}
      />
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

  // While the recovery effect above resets the inconsistent state, show a
  // spinner rather than flashing either the camera or the degraded completion
  // screen.
  if (liveCompletionMissingRecord) {
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
      </YStack>
    )
  }

  // Completion screen - shown immediately after recording. For the live create
  // flow this is only reached with a provisioned bondfire id (see the invariant
  // above), so the completion screen always has a title to edit and a row to
  // share; the id-less branch is only for responses and legacy uploads.
  if (recordingPhase === 'completion' && videoUri) {
    const completionDetail = respondTo
      ? 'Awesome, great video! We are getting your response ready now. It may take up to two minutes to show in activity lists.'
      : isPersonalCamp
        ? 'Your Personal Bondfire is being processed. Invite someone to join the conversation!'
        : 'Awesome, great video! We are getting it ready now. It may take up to two minutes for your video to show in Discover, Recent, and Active.'

    // The inline title field / Invite button only apply when the user owns
    // the just-created bondfire and it already exists server-side: the
    // live-publish camp and personal flows. Responses edit someone else's
    // bondfire, and legacy background uploads have no bondfire ID yet.
    const editableBondfireId =
      !respondTo && shouldUseLivePublish && liveRecordId
        ? (liveRecordId as Id<'bondfires'>)
        : undefined

    return (
      <CompletionScreen
        detail={completionDetail}
        bondfireId={editableBondfireId}
        campName={selectedCamp?.name}
        inviteMode={isPersonalCamp ? 'personal-bondfire' : 'bondfire'}
        onContinue={() => {
          // Always return to the Feed with the navigation stack reset — for
          // every flow (camp, personal hearth, and responses). Previously
          // personal routed to the hearth screen and camp/responses to a
          // bondfire detail page, which could strand the user behind pushed
          // screens (and, for personal, an auto-opened invite sheet) requiring
          // multiple back presses to escape. dismissAll() clears any pushed
          // (main)-stack screens; replace() then selects the Feed tab.
          if (router.canDismiss()) {
            router.dismissAll()
          }
          router.replace(routes.feed)

          // Tear down completion state NOW instead of waiting for the
          // blur→refocus effect above. That effect is only a safety net: some
          // exit routes never produce the focus transition it expects, which
          // left phase stuck at 'completion'. Re-entering this tab then showed
          // a zombie completion screen — and because recordId had already been
          // reset, it rendered without the title field — instead of the camera.
          livePublishActions.reset()
          recordingActions.resetFlow('completion dismissed via continue')
        }}
      />
    )
  }

  if (shouldUseLivePublish) {
    return (
      <LiveRecordScreen
        respondTo={respondTo}
        isPersonalCamp={isPersonalCamp}
        effectiveCampId={effectiveCampId}
        selectedCamp={selectedCamp}
        selectedCampTags={selectedCampTags}
        effectiveMaxRecordingSeconds={effectiveMaxRecordingSeconds}
        currentUser={currentUser}
        canCreate={canCreate}
        needsTradeTag={needsTradeTag}
        onSelectTradeTag={handleSelectTradeTag}
        isCampListLoaded={camps !== undefined}
        shouldRenderCamera={!!shouldRenderCamera}
        onBack={handleBack}
        logRecordingError={logRecordingError}
        personalCreateStartedAtRef={personalCreateStartedAtRef}
      />
    )
  }

  return (
    <LegacyRecordScreen
      respondTo={respondTo}
      isPersonalCamp={isPersonalCamp}
      effectiveCampId={effectiveCampId}
      selectedCamp={selectedCamp}
      selectedCampTags={selectedCampTags}
      effectiveMaxRecordingSeconds={effectiveMaxRecordingSeconds}
      currentUser={currentUser}
      canCreate={canCreate}
      showPaywall={showPaywall}
      needsTradeTag={needsTradeTag}
      shouldRenderCamera={!!shouldRenderCamera}
      onBack={handleBack}
      logRecordingError={logRecordingError}
      personalCreateStartedAtRef={personalCreateStartedAtRef}
      clearUploadStartTimeout={clearUploadStartTimeout}
    />
  )
}
