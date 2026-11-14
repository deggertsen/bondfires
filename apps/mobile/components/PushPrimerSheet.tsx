import {
  appActions,
  appStore$,
  canConsiderPushNudge,
  getPushPermissionState,
  onReturnToApp,
  type PushNudgeMode,
  pushNudgeMode,
  requestPushFromNudge,
  requestPushPermission,
  settlePushSettingsReturn,
  telemetry,
} from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { Bell, BellOff } from '@tamagui/lucide-icons'
import * as Device from 'expo-device'
import { useEffect, useRef, useState } from 'react'
import { Linking, Platform } from 'react-native'
import { Sheet, YStack } from 'tamagui'

/**
 * Where the sheet is shown. The completion screen follows a recording the
 * user just made; the feed nudge comes back in later sessions, where the
 * broader "your people" framing fits better than one specific Bondfire.
 */
export type PushPrimerContext = 'completion' | 'feed'

type PrimerCopy = { title: string; body: string; primary: string }

/** What to tap once the app's page in system Settings opens. */
const SETTINGS_STEPS =
  Platform.OS === 'ios'
    ? 'Tap Notifications, then turn on Allow Notifications.'
    : 'Tap Notifications, then turn them on.'

const COPY: Record<PushPrimerContext, Record<PushNudgeMode, PrimerCopy>> = {
  completion: {
    request: {
      title: 'Want to know when someone responds to you?',
      body: 'Get a notification when someone adds a video to your Bondfire.',
      primary: 'Notify me',
    },
    settings: {
      title: 'Notifications are off',
      body: 'Turn them on in Settings to hear when someone responds to your Bondfire.',
      primary: 'Open Settings',
    },
  },
  feed: {
    request: {
      title: 'Turn on notifications?',
      body: 'Know when your people start a Bondfire or reply to yours.',
      primary: 'Notify me',
    },
    settings: {
      title: 'Notifications are off',
      body: 'Turn them on in Settings to know when your people start a Bondfire or reply to yours.',
      primary: 'Open Settings',
    },
  },
}

/**
 * In-app pre-prompt (nudge) for push notification permission.
 *
 * The OS permission dialog is one-shot on iOS, so we never fire it cold.
 * This sheet asks first and only fires the OS dialog after an explicit yes.
 * When the OS will no longer prompt (`canAskAgain` false) it points the user
 * at system Settings instead.
 *
 * Mounted globally (PushPermissionNudge, on the feed once the user has recorded)
 * and on the finished-recording screen. Both mounts share the primer state
 * in the app store, and the primer is claimed synchronously so two mounts
 * in the same moment cannot both open.
 *
 * Self-gating: renders nothing unless this is a physical device, the in-app
 * notifications preference is on, the primer is eligible (never accepted,
 * not yet shown this app session) and OS permission isn't
 * already granted.
 * Mount it with `trigger` set when the moment is right.
 */
interface PushPrimerSheetProps {
  /** Set true at the moment the primer should be considered (e.g. on the completion screen). */
  trigger: boolean
  /** Picks the copy: see `PushPrimerContext`. */
  context: PushPrimerContext
}

export function PushPrimerSheet({ trigger, context }: PushPrimerSheetProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PushNudgeMode>('request')
  // Guards against the sheet's close callback recording a decline after the
  // user already answered with a button.
  const answeredRef = useRef(false)

  useEffect(() => {
    if (!trigger) return
    const eligible = canConsiderPushNudge({
      isPhysicalDevice: Device.isDevice,
      notificationsEnabled: appStore$.preferences.notificationsEnabled.peek(),
      primerEligible: appActions.shouldShowPushPrimer(),
    })
    if (!eligible) return

    // Claim before any await: records "shown" so a second mount sees it was shown this session.
    const release = appActions.claimPushPrimer()
    if (!release) return

    let settled = false
    getPushPermissionState().then((permission) => {
      if (settled) return
      settled = true
      const nextMode = permission ? pushNudgeMode(permission) : null
      if (!permission || !nextMode) {
        release()
        return
      }
      answeredRef.current = false
      setMode(nextMode)
      setOpen(true)
      telemetry.breadcrumb('push:nudge:shown', {
        canAskAgain: permission.canAskAgain,
        status: permission.status,
      })
    })

    return () => {
      if (settled) return
      settled = true
      release()
    }
  }, [trigger])

  const handleRequest = async () => {
    telemetry.breadcrumb('push:primer:accepted')
    telemetry.breadcrumb('push:nudge:accepted')
    try {
      const granted = await requestPushFromNudge(
        requestPushPermission,
        appActions.recordPushPrimerAccepted,
      )
      telemetry.breadcrumb('push:primer:result', { granted })
      telemetry.breadcrumb('push:nudge:result', { granted })
    } catch (e) {
      telemetry.warn('push:primer', 'Permission request from primer failed', {
        error: String(e),
      })
    }
  }

  const handleOpenSettings = async () => {
    telemetry.breadcrumb('push:nudge:settings')
    // Coming back with notifications allowed counts as accepted; still off
    // counts as a decline, the same as "Not now".
    const cancel = onReturnToApp(() => {
      void getPushPermissionState().then((permission) => {
        const granted = permission?.granted ?? false
        telemetry.breadcrumb('push:nudge:returnFromSettings', { granted })
        settlePushSettingsReturn(granted, {
          recordAccepted: appActions.recordPushPrimerAccepted,
          recordDeclined: appActions.recordPushPrimerDeclined,
        })
      })
    })
    try {
      await Linking.openSettings()
    } catch (e) {
      cancel()
      telemetry.warn('push:primer', 'Opening system settings from primer failed', {
        error: String(e),
      })
    }
  }

  const handlePrimary = () => {
    answeredRef.current = true
    setOpen(false)
    if (mode === 'settings') {
      void handleOpenSettings()
      return
    }
    void handleRequest()
  }

  const handleNotNow = () => {
    if (answeredRef.current) return
    answeredRef.current = true
    setOpen(false)
    appActions.recordPushPrimerDeclined()
    telemetry.breadcrumb('push:primer:declined')
    telemetry.breadcrumb('push:nudge:declined')
  }

  const copy = COPY[context][mode]

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen && open) {
          handleNotNow()
        }
      }}
      snapPointsMode="fit"
      dismissOnSnapToBottom
    >
      <Sheet.Overlay animation="quick" enterStyle={{ opacity: 0 }} exitStyle={{ opacity: 0 }} />
      <Sheet.Frame padding={24} gap={16} alignItems="center">
        <YStack
          width={56}
          height={56}
          borderRadius={28}
          backgroundColor={'$primary'}
          alignItems="center"
          justifyContent="center"
        >
          {mode === 'settings' ? (
            <BellOff size={28} color="white" />
          ) : (
            <Bell size={28} color="white" />
          )}
        </YStack>

        <Text fontSize={20} fontWeight="700" textAlign="center">
          {copy.title}
        </Text>

        <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
          {copy.body}
        </Text>

        {mode === 'settings' && (
          <Text fontSize={14} fontWeight="600" textAlign="center">
            {SETTINGS_STEPS}
          </Text>
        )}

        <YStack gap={10} width="100%" marginTop={8}>
          <Button variant="primary" size="$lg" onPress={handlePrimary}>
            <Text color={'$color'} fontWeight="700">
              {copy.primary}
            </Text>
          </Button>
          <Button variant="outline" size="$lg" onPress={handleNotNow}>
            <Text color={'$color'}>Not now</Text>
          </Button>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}
