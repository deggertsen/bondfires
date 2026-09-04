import { appStore$, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { ArrowLeft, ShieldCheck } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import { routes } from '../../../lib/routes'

function inviteError(reason: string | undefined): string {
  if (reason === 'expired') return 'This family invitation has expired. Ask for a new link.'
  if (reason === 'used') return 'This family invitation has already been used.'
  if (reason === 'ended' || reason === 'unavailable') {
    return 'The Hearth Bondfire connected to this invitation is no longer available.'
  }
  return 'This family invitation could not be found.'
}

export default function FamilyInviteScreen() {
  const { code: codeParam } = useLocalSearchParams<{ code: string | string[] }>()
  const code = Array.isArray(codeParam) ? codeParam[0] : codeParam
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const preview = useQuery(api.familyConnections.checkInvite, code ? { code } : 'skip')
  const acceptInvite = useMutation(api.familyConnections.acceptInvite)
  const [isAccepting, setIsAccepting] = useState(false)

  if (!isAuthenticated && code) {
    return <Redirect href={routes.loginWithFamilyInvite(code)} />
  }

  const handleAccept = async () => {
    if (!code || isAccepting) return
    setIsAccepting(true)
    try {
      const result = await acceptInvite({ code })
      router.replace(routes.bondfire(result.bondfireId))
    } catch (error) {
      Alert.alert(
        'Could not accept invitation',
        error instanceof Error ? error.message : 'Please request a new family invitation.',
      )
    } finally {
      setIsAccepting(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <YStack flex={1} backgroundColor="$background" paddingHorizontal={24}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <Pressable
          onPress={() => router.replace(routes.feed)}
          accessibilityRole="button"
          accessibilityLabel="Decline family invitation"
          style={{ marginTop: 58 }}
        >
          <YStack
            width={42}
            height={42}
            borderRadius={21}
            alignItems="center"
            justifyContent="center"
            backgroundColor="$backgroundHover"
            borderWidth={1}
            borderColor="$borderColor"
          >
            <ArrowLeft size={22} color="$color" />
          </YStack>
        </Pressable>

        <YStack flex={1} justifyContent="center" gap={20} paddingBottom={80}>
          <YStack
            width={76}
            height={76}
            borderRadius={24}
            backgroundColor="$primary"
            alignSelf="center"
            alignItems="center"
            justifyContent="center"
          >
            <ShieldCheck size={40} color="$color" />
          </YStack>

          {code && preview === undefined ? (
            <Spinner size="large" color="$primary" />
          ) : preview?.valid ? (
            <>
              <Text fontSize={24} fontWeight="900" textAlign="center">
                Family Hearth invitation
              </Text>
              <Text fontSize={16} color="$color" textAlign="center" lineHeight={23}>
                {preview.inviterName} invited you to connect privately and join
                {preview.bondfireTitle ? ` “${preview.bondfireTitle}”.` : ' a Hearth Bondfire.'}
              </Text>
              <YStack
                backgroundColor="$backgroundHover"
                borderColor="$borderColor"
                borderWidth={1}
                borderRadius={16}
                padding={16}
                gap={10}
              >
                <Text fontWeight="800">Only accept someone you know and trust offline.</Text>
                <Text color="$placeholderColor" lineHeight={20}>
                  Accepting creates a private family connection that can be used for future Hearth
                  invitations, including across teen and adult age groups. Bondfires does not verify
                  legal or biological relationships. Either person can revoke the connection from
                  Profile at any time.
                </Text>
              </YStack>
              <Button
                variant="primary"
                size="$lg"
                onPress={handleAccept}
                disabled={isAccepting}
                icon={isAccepting ? <Spinner size="small" color="$color" /> : undefined}
              >
                <Text fontWeight="800">{isAccepting ? 'Accepting…' : 'Accept and join'}</Text>
              </Button>
              <Button
                variant="outline"
                size="$lg"
                onPress={() => router.replace(routes.feed)}
                disabled={isAccepting}
              >
                <Text fontWeight="700">Decline</Text>
              </Button>
            </>
          ) : (
            <>
              <Text fontSize={24} fontWeight="900" textAlign="center">
                Invitation unavailable
              </Text>
              <Text color="$placeholderColor" textAlign="center" lineHeight={22}>
                {inviteError(preview?.reason)}
              </Text>
              <Button variant="primary" size="$lg" onPress={() => router.replace(routes.feed)}>
                <Text fontWeight="800">Return to Bondfires</Text>
              </Button>
            </>
          )}
        </YStack>
      </YStack>
    </>
  )
}
