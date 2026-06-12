import {
  appActions,
  isPushPermissionGranted,
  requestPushPermission,
  telemetry,
} from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { Bell } from '@tamagui/lucide-icons'
import { useEffect, useState } from 'react'
import { Sheet, YStack } from 'tamagui'

/**
 * In-app pre-prompt for push notification permission.
 *
 * The OS permission dialog is one-shot on iOS, so we never fire it cold.
 * This sheet asks first, at a high-intent moment — the finished-recording
 * screen right after the user commits their first video — and only fires
 * the OS dialog after an explicit yes.
 *
 * Self-gating: renders nothing unless the primer is currently eligible
 * (never accepted, < 3 declines, 7-day cooldown) and OS permission isn't
 * already granted. Mount it with `trigger` set when the moment is right.
 */
interface PushPrimerSheetProps {
  /** Set true at the moment the primer should be considered (e.g. on the completion screen). */
  trigger: boolean
}

export function PushPrimerSheet({ trigger }: PushPrimerSheetProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!trigger) return
    if (!appActions.shouldShowPushPrimer()) return

    let cancelled = false
    isPushPermissionGranted().then((granted) => {
      if (cancelled || granted) return
      appActions.recordPushPrimerShown()
      setOpen(true)
    })

    return () => {
      cancelled = true
    }
  }, [trigger])

  const handleYes = async () => {
    setOpen(false)
    appActions.recordPushPrimerAccepted()
    try {
      await requestPushPermission()
    } catch (e) {
      telemetry.warn('push:primer', 'Permission request from primer failed', {
        error: String(e),
      })
    }
  }

  const handleNotNow = () => {
    setOpen(false)
    appActions.recordPushPrimerDeclined()
  }

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
          <Bell size={28} color="white" />
        </YStack>

        <Text fontSize={20} fontWeight="700" textAlign="center">
          Want to know when someone responds to you?
        </Text>

        <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
          Get a notification when someone adds a video to your Bondfire.
        </Text>

        <YStack gap={10} width="100%" marginTop={8}>
          <Button variant="primary" size="$lg" onPress={handleYes}>
            <Text color={'$color'} fontWeight="700">
              Notify me
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
