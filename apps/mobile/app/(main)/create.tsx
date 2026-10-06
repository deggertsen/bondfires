import { appActions, appStore$, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { ChevronLeft, Flame } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Pressable, StatusBar } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { CampPickerScreen } from '../../components/create/CampPickerScreen'
import { PreRecordingInviteScreen } from '../../components/create/PreRecordingInviteScreen'
import { SegmentRecordScreen } from '../../components/create/SegmentRecordScreen'
import type { TradeTag } from '../../components/create/shared'
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
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const navigation = useNavigation()
  const { campId, respondTo, personalCamp, resumeDraft } = useLocalSearchParams<{
    campId?: string
    respondTo?: string
    personalCamp?: string
    resumeDraft?: string
  }>()
  const isPersonalCamp = personalCamp === '1'
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
    selectedCampId: null as Id<'camps'> | null,
    promptCampId: null as Id<'camps'> | null,
    promptDismissed: false,
    tradeTag: null as TradeTag | null,
  })

  const isAppActive = useValue(state$.isAppActive)
  const selectedCampId = useValue(state$.selectedCampId)
  const promptDismissed = useValue(state$.promptDismissed)
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
  const personalCampDoc = useQuery(api.personalCamps.getMyPersonalCamp, {})
  const existingDraft = useQuery(
    api.personalBondfires.getMyDraftBondfire,
    isPersonalCamp ? {} : 'skip',
  )
  useEffect(() => {
    // Resolve the exact owner draft before bypassing audience setup. Retain the
    // selection when uploading activates it and getMyDraftBondfire becomes null.
    if (resumeDraft && existingDraft?._id === resumeDraft && !draftBondfireId) {
      draftBondfireId$.set(existingDraft._id)
    }
  }, [resumeDraft, existingDraft, draftBondfireId, draftBondfireId$])
  const joinCamp = useMutation(api.camps.join)
  const persistedCampId = currentCampId as Id<'camps'> | null
  const effectiveCampId = respondTo
    ? undefined
    : isPersonalCamp
      ? undefined
      : ((campId as Id<'camps'> | undefined) ?? selectedCampId ?? undefined)
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

  // Spark tab and other generic /create entry points carry no campId param. Clear
  // any lingering in-screen camp selection from a prior visit so we always land
  // on the camp picker instead of replaying the Welcome Fires prompt.
  useEffect(() => {
    if (!isFocused || respondTo || isPersonalCamp || campId) {
      return
    }

    state$.selectedCampId.set(null)
    state$.promptCampId.set(null)
    state$.promptDismissed.set(true)
    state$.tradeTag.set(null)
  }, [campId, isFocused, isPersonalCamp, respondTo, state$])

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

  const handleCampConfirmed = useCallback(
    (selectedId: Id<'camps'>) => {
      state$.selectedCampId.set(selectedId)
      state$.tradeTag.set(null)
      appActions.setCurrentCampId(selectedId)
    },
    [state$],
  )

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
        onBack={handleBack}
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
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{
            position: 'absolute',
            top: insets.top + 12,
            left: 20,
            minWidth: 44,
            minHeight: 44,
            justifyContent: 'center',
          }}
        >
          <ChevronLeft size={26} color={'$color'} />
        </Pressable>
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
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{
            position: 'absolute',
            top: insets.top + 12,
            left: 20,
            minWidth: 44,
            minHeight: 44,
            justifyContent: 'center',
          }}
        >
          <ChevronLeft size={26} color={'$color'} />
        </Pressable>
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

  // Pre-recording invite screen for Hearth (personal camp) bondfires.
  // Shown before the recording screen so the audience is established first.
  if (isPersonalCamp && !respondTo && !draftBondfireId && !inviteSkipped) {
    // Resolve the one-draft-at-a-time state before exposing Skip. Otherwise a
    // fast tap during the query's initial undefined state can bypass an
    // existing audience and orphan that draft until cleanup.
    if (existingDraft === undefined) {
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
          <Text color={'$placeholderColor'}>Loading your Hearth...</Text>
        </YStack>
      )
    }

    return (
      <PreRecordingInviteScreen
        existingDraft={existingDraft}
        onContinue={(bondfireId, _title) => {
          draftBondfireId$.set(bondfireId)
        }}
        onSkip={() => {
          inviteSkipped$.set(true)
        }}
        onCancel={() => {
          if (router.canDismiss()) {
            router.dismissAll()
          }
          router.replace(routes.feed)
        }}
      />
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
      campName={selectedCamp?.name}
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
        campId: effectiveCampId,
        personalCamp: isPersonalCamp,
        tags: selectedCampTags,
        draftBondfireId: nextResponse ? null : (draftBondfireId as Id<'bondfires'> | null),
      }}
    />
  )
}
