import { appActions, appStore$, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { Flame } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { CampSparkPane } from '../../components/create/CampSparkPane'
import { PreRecordingInviteScreen } from '../../components/create/PreRecordingInviteScreen'
import { SegmentRecordScreen } from '../../components/create/SegmentRecordScreen'
import { SparkModeToggle } from '../../components/create/SparkModeToggle'
import type { TradeTag } from '../../components/create/shared'
import {
  buildCampPickerList,
  orderedPickableCamps,
  resolveInitialSparkMode,
  resolveSelectedCampId,
  type SparkMode,
} from '../../components/create/sparkComposer'
import { segmentMediaEnabled } from '../../lib/media/segmentUploads'
import { goBackOrReplace } from '../../lib/navigation'
import { routes } from '../../lib/routes'

export default function CreateScreen() {
  return segmentMediaEnabled ? <EnabledCreateScreen /> : <RecordingUnavailableScreen />
}

function RecordingUnavailableScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  return (
    <YStack flex={1} backgroundColor="$background" justifyContent="center" padding="$4" gap="$3">
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <Text fontSize={20} fontWeight="600">
        Recording unavailable
      </Text>
      <Text color="$placeholderColor">Recording is not available in this version of the app.</Text>
      <Button onPress={() => router.replace(routes.feed)}>Back to feed</Button>
    </YStack>
  )
}

// Keep permissions, draft creation and capture behind the same availability
// gate as the uploader so disabled builds cannot accumulate unsendable videos.
function EnabledCreateScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  // `personalCamp=1` still arrives from Hearth entry points; People is the
  // default for every fresh entry now, so it needs no special handling.
  const { campId, respondTo, resumeDraft } = useLocalSearchParams<{
    campId?: string
    respondTo?: string
    resumeDraft?: string
  }>()
  // Each attempt mounts a fresh recorder with its own durable upload journal.
  const [nextResponse, setNextResponse] = useState<{
    bondfireId: Id<'bondfires'>
    attempt: number
  } | null>(null)
  const isFocused = useIsFocused()

  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [micPermission, requestMicPermission] = useMicrophonePermissions()
  const requestingPermissions = useRef(false)

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
    // People unless the caller scoped this spark to a camp.
    mode: resolveInitialSparkMode({ campId }) as SparkMode,
    /** Camp chosen in the camp sheet; null until the user picks one. */
    pickedCampId: null as Id<'camps'> | null,
    /** Set when "Record in {camp}" is pressed — hands off to the recorder. */
    campConfirmed: false,
    tradeTag: null as TradeTag | null,
  })

  const isAppActive = useValue(state$.isAppActive)
  const mode = useValue(state$.mode)
  const pickedCampId = useValue(state$.pickedCampId)
  const campConfirmed = useValue(state$.campConfirmed)
  const tradeTag = useValue(state$.tradeTag)
  const currentCampId = useValue(appStore$.currentCampId)
  const draftBondfireId$ = useObservable<string | null>(null)
  const draftBondfireId = useValue(draftBondfireId$)
  // "Skip — record without inviting" on the pre-recording invite screen:
  // record the old way (bondfire created at recording time, no draft).
  const inviteSkipped$ = useObservable(false)
  const inviteSkipped = useValue(inviteSkipped$)

  const camps = useQuery(api.camps.list, respondTo ? 'skip' : {})
  const subscription = useQuery(api.subscriptions.current, {})
  const currentUser = useQuery(api.users.current)
  const existingDraft = useQuery(api.personalBondfires.getMyDraftBondfire, respondTo ? 'skip' : {})
  useEffect(() => {
    // Resolve the exact owner draft before bypassing audience setup. Retain the
    // selection when uploading activates it and getMyDraftBondfire becomes null.
    if (resumeDraft && existingDraft?._id === resumeDraft && !draftBondfireId) {
      draftBondfireId$.set(existingDraft._id)
    }
  }, [resumeDraft, existingDraft, draftBondfireId, draftBondfireId$])
  const joinCamp = useMutation(api.camps.join)
  const persistedCampId = currentCampId as Id<'camps'> | null

  const campPickerList = useMemo(
    () => (camps ? buildCampPickerList(camps, persistedCampId) : null),
    [camps, persistedCampId],
  )
  const pickableCamps = useMemo(
    () => (campPickerList ? orderedPickableCamps(campPickerList) : []),
    [campPickerList],
  )
  const selectedCampId = resolveSelectedCampId(pickableCamps, {
    pickedCampId,
    paramCampId: campId,
    lastUsedCampId: persistedCampId,
  })
  const selectedCamp = useMemo(
    () => pickableCamps.find((camp) => camp._id === selectedCampId) ?? null,
    [pickableCamps, selectedCampId],
  )
  const requestedCampUnavailable =
    !!campId && camps !== undefined && !pickableCamps.some((camp) => camp._id === campId)

  // What the recorder is about to capture. Null keeps the composer up.
  const recordingTarget: 'response' | 'personal' | 'camp' | null = respondTo
    ? 'response'
    : draftBondfireId || inviteSkipped
      ? 'personal'
      : campConfirmed && selectedCamp
        ? 'camp'
        : null

  const selectedCampTags = recordingTarget === 'camp' && tradeTag ? [tradeTag] : undefined
  const selectedCampMaxSeconds = selectedCamp?.rules.participation.maxDurationMs
    ? Math.floor(selectedCamp.rules.participation.maxDurationMs / 1000)
    : undefined
  const tierMaxSeconds = subscription?.maxVideoDurationMs
    ? Math.floor(subscription.maxVideoDurationMs / 1000)
    : undefined
  const campMaxRecordingSeconds = useMemo(() => {
    const limits = [selectedCampMaxSeconds, tierMaxSeconds].filter(
      (limit): limit is number => typeof limit === 'number' && limit > 0,
    )
    return limits.length > 0 ? Math.min(...limits) : undefined
  }, [selectedCampMaxSeconds, tierMaxSeconds])
  // Camp limits only apply to camp fires; Hearth fires and responses keep the
  // tier limit alone.
  const effectiveMaxRecordingSeconds =
    recordingTarget === 'camp' ? campMaxRecordingSeconds : tierMaxSeconds

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

  const requestPermissions = useCallback(async () => {
    // Wait for the permission reads before requesting. Re-requesting already
    // granted permissions can briefly background Android's warmed camera.
    if (!cameraPermission || !micPermission || requestingPermissions.current) return
    requestingPermissions.current = true
    try {
      if (!cameraPermission.granted) await requestCameraPermission()
      if (!micPermission.granted) await requestMicPermission()
    } finally {
      requestingPermissions.current = false
    }
  }, [cameraPermission, micPermission, requestCameraPermission, requestMicPermission])

  useEffect(() => {
    if (cameraPermission?.status === 'undetermined' || micPermission?.status === 'undetermined') {
      void requestPermissions()
    }
  }, [cameraPermission?.status, micPermission?.status, requestPermissions])

  const handleSelectCamp = useCallback(
    (id: Id<'camps'>) => {
      state$.pickedCampId.set(id)
      state$.tradeTag.set(null)
    },
    [state$],
  )

  const handleRecordInCamp = useCallback(() => {
    if (!selectedCamp) return
    appActions.setCurrentCampId(selectedCamp._id)
    state$.campConfirmed.set(true)
  }, [selectedCamp, state$])

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

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

  if (resumeDraft && !draftBondfireId) {
    return (
      <YStack flex={1} backgroundColor="$background" justifyContent="center" padding="$4" gap="$3">
        {existingDraft === undefined || existingDraft?._id === resumeDraft ? (
          <Spinner />
        ) : (
          <>
            <Text>This draft has expired or already has a recording.</Text>
            <Button onPress={() => router.replace(routes.bondfire(resumeDraft))}>
              View Bondfire
            </Button>
          </>
        )}
      </YStack>
    )
  }

  // Spark composer: People (Hearth invite screen) | Camp. Both panes stay
  // mounted so a round trip through the other tab keeps what was picked; only
  // the active tab's choice is used.
  if (recordingTarget === null) {
    const modeToggle = (
      <SparkModeToggle mode={mode} onChange={(nextMode) => state$.mode.set(nextMode)} />
    )
    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <YStack flex={1} display={mode === 'people' ? 'flex' : 'none'}>
          {/* Resolve the one-draft-at-a-time state before exposing Skip.
              Otherwise a fast tap during the query's initial undefined state
              can bypass an existing audience and orphan that draft. */}
          {existingDraft === undefined ? (
            <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
              <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
              <Spinner size="large" color={'$primary'} />
              <Text color={'$placeholderColor'}>Loading your Hearth...</Text>
            </YStack>
          ) : (
            <PreRecordingInviteScreen
              existingDraft={existingDraft}
              modeToggle={modeToggle}
              onContinue={(bondfireId, _title) => {
                draftBondfireId$.set(bondfireId)
              }}
              onSkip={() => {
                inviteSkipped$.set(true)
              }}
              onCancel={handleBack}
            />
          )}
        </YStack>
        <YStack flex={1} display={mode === 'camp' ? 'flex' : 'none'}>
          <CampSparkPane
            modeToggle={modeToggle}
            onClose={handleBack}
            camps={camps}
            pickerList={campPickerList}
            selectedCamp={selectedCamp}
            requestedCampUnavailable={requestedCampUnavailable}
            maxRecordingSeconds={campMaxRecordingSeconds}
            tradeTag={tradeTag}
            userGender={currentUser?.gender}
            joinCamp={joinCamp}
            onSelectCamp={handleSelectCamp}
            onTradeTagChange={(tag) => state$.tradeTag.set(tag)}
            onRecord={handleRecordInCamp}
          />
        </YStack>
      </YStack>
    )
  }

  // Segmented capture is the only recording path. It owns its own completion
  // screen and durable upload journal per attempt.
  if (!currentUser)
    return (
      <YStack flex={1} backgroundColor="$background" justifyContent="center">
        <Spinner />
      </YStack>
    )
  return (
    <SegmentRecordScreen
      key={nextResponse?.attempt ?? 0}
      userId={currentUser._id}
      campName={recordingTarget === 'camp' ? selectedCamp?.name : undefined}
      isScreenFocused={isFocused}
      isAppActive={isAppActive}
      onContinue={() => {
        if (router.canDismiss()) router.dismissAll()
        router.replace(routes.feed)
      }}
      onRecordAnother={(bondfireId) =>
        setNextResponse((previous) => ({ bondfireId, attempt: (previous?.attempt ?? 0) + 1 }))
      }
      maxDuration={Math.min(3600, effectiveMaxRecordingSeconds ?? 3600)}
      onBack={handleBack}
      options={{
        isResponse: !!nextResponse || !!respondTo,
        bondfireId: nextResponse?.bondfireId ?? (respondTo as Id<'bondfires'> | undefined),
        campId: recordingTarget === 'camp' ? selectedCamp?._id : undefined,
        personalCamp: recordingTarget === 'personal',
        tags: selectedCampTags,
        draftBondfireId: nextResponse ? null : (draftBondfireId as Id<'bondfires'> | null),
      }}
    />
  )
}
