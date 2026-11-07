import { useSystemThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { ShieldAlert } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { routes } from '../../lib/routes'
import { clearRegistrationDestination } from '../../lib/socialAuth'

/**
 * Shown when a later device age range reported someone under 13. The account
 * is kept, nothing is deleted, and registration is never reopened (that would
 * let a typed month override the phone). A later eligible device check restores
 * access; the only manual action here is signing out.
 */
export default function AgeBlockedScreen() {
  const { colors, statusBarStyle } = useSystemThemeColors()
  const { signOut } = useAuthActions()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <YStack
      flex={1}
      backgroundColor="$background"
      justifyContent="center"
      alignItems="center"
      padding={24}
      gap={16}
    >
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <ShieldAlert size={48} color="$primary" />
      <Text fontSize={24} fontWeight="700" textAlign="center">
        Bondfires isn’t available for your age range
      </Text>
      <Text fontSize={15} color="$placeholderColor" textAlign="center">
        Your device reported an age range that Bondfires doesn’t support. Your account has not been
        deleted. The app periodically checks your device again when you open it.
      </Text>
      <Button
        variant="outline"
        size="$md"
        disabled={busy}
        onPress={async () => {
          setBusy(true)
          try {
            clearRegistrationDestination()
            await signOut()
          } finally {
            setBusy(false)
            router.replace(routes.login())
          }
        }}
      >
        <Text>Sign out</Text>
      </Button>
    </YStack>
  )
}
