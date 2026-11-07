import { getAuthErrorMessage, useSystemThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { ShieldAlert } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { routes } from '../../lib/routes'
import { clearRegistrationDestination } from '../../lib/socialAuth'

/**
 * Shown when a later device age range blocked the account: under 13, or 13–17
 * on an adult account (adult accounts never move to the teen band). The
 * account is kept and registration is never reopened (that would let a typed
 * month override the phone). A later eligible device check restores access.
 * A teen on an adult account can delete it and start over with a teen account.
 */
export default function AgeBlockedScreen() {
  const { colors, statusBarStyle } = useSystemThemeColors()
  const { signOut } = useAuthActions()
  const router = useRouter()
  const currentUser = useQuery(api.users.current)
  const deleteAccount = useMutation(api.accountDeletion.request)
  const [busy, setBusy] = useState(false)
  const teenOnAdultAccount = currentUser?.ageBlockedReason === 'teen_on_adult_account'

  const handleSignOut = async () => {
    setBusy(true)
    try {
      clearRegistrationDestination()
      await signOut()
    } finally {
      setBusy(false)
      router.replace(routes.login())
    }
  }

  const handleStartOver = () => {
    Alert.alert(
      'Delete this account?',
      'This adult account and everything in it will be permanently deleted. You can then create a teen account. It may take a few minutes before your email can be used again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            try {
              await deleteAccount()
              clearRegistrationDestination()
              await signOut()
              router.replace(routes.signup)
            } catch (error) {
              Alert.alert('Could not delete account', getAuthErrorMessage(error))
            } finally {
              setBusy(false)
            }
          },
        },
      ],
    )
  }

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
      {teenOnAdultAccount ? (
        <>
          <Text fontSize={24} fontWeight="700" textAlign="center">
            This is an adult account
          </Text>
          <Text fontSize={15} color="$placeholderColor" textAlign="center">
            Your device says you’re 13–17. Bondfires keeps teen and adult communities separate, so
            you’ll need a teen account. Delete this account to start over, or if your device’s age
            is wrong, fix it in your phone’s account settings and the app will check again.
          </Text>
          <Button variant="primary" size="$md" disabled={busy} onPress={handleStartOver}>
            <Text>Delete account and start over</Text>
          </Button>
        </>
      ) : (
        <>
          <Text fontSize={24} fontWeight="700" textAlign="center">
            Bondfires isn’t available for your age range
          </Text>
          <Text fontSize={15} color="$placeholderColor" textAlign="center">
            Your device reported an age range that Bondfires doesn’t support. Your account has not
            been deleted. The app periodically checks your device again when you open it.
          </Text>
        </>
      )}
      <Button variant="outline" size="$md" disabled={busy} onPress={handleSignOut}>
        <Text>Sign out</Text>
      </Button>
    </YStack>
  )
}
