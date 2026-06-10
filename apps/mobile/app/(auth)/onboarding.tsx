import { appActions, useAppThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { Flame } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { routes } from '../../lib/routes'

export default function OnboardingScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()

  const handleContinue = () => {
    appActions.completeOnboarding()
    router.replace(routes.signup)
  }

  const handleLogin = () => {
    appActions.completeOnboarding()
    router.replace(routes.login())
  }

  return (
    <YStack flex={1} backgroundColor={'$background'} paddingHorizontal={24} paddingVertical={60}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

      <YStack flex={1} justifyContent="center" alignItems="center" gap={40}>
        {/* Logo */}
        <YStack
          width={120}
          height={120}
          borderRadius={60}
          backgroundColor={'$backgroundHover'}
          alignItems="center"
          justifyContent="center"
          borderWidth={3}
          borderColor={'$primary'}
        >
          <Flame size={60} color={'$primary'} />
        </YStack>

        <YStack alignItems="center" gap={12}>
          <Text fontSize={32} fontWeight="800" textAlign="center">
            Welcome to Bondfires
          </Text>
          <Text fontSize={16} color={'$placeholderColor'} textAlign="center" maxWidth={300}>
            Share video moments and respond to others to build meaningful connections.
          </Text>
        </YStack>

        {/* How it works */}
        <YStack gap={24} width="100%" maxWidth={320} marginTop={20}>
          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={'$primary'}
            >
              <Text fontWeight="700" color={'$primary'}>
                1
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16} color={'$colorHover'}>
                Spark a Bondfire
              </Text>
              <Text fontSize={14} color={'$placeholderColor'}>
                Record and share a video to start a conversation.
              </Text>
            </YStack>
          </XStack>

          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={'$secondary'}
            >
              <Text fontWeight="700" color={'$secondary'}>
                2
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16} color={'$colorHover'}>
                Respond to Others
              </Text>
              <Text fontSize={14} color={'$placeholderColor'}>
                Add your video response to keep the bondfire growing.
              </Text>
            </YStack>
          </XStack>

          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={'$primaryPress'}
            >
              <Text fontWeight="700" color={'$primaryPress'}>
                3
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16} color={'$colorHover'}>
                Build Connections
              </Text>
              <Text fontSize={14} color={'$placeholderColor'}>
                Watch bondfires grow as more people join in.
              </Text>
            </YStack>
          </XStack>
        </YStack>
      </YStack>

      <YStack gap={12} marginTop={24}>
        <Button variant="primary" size="$lg" onPress={handleContinue}>
          <Flame size={20} color={'$color'} />
          <Text color={'$color'}>Get Started</Text>
        </Button>
        <Button variant="ghost" size="$md" onPress={handleLogin}>
          <YStack alignItems="center" gap={2}>
            <Text fontSize={14} color={'$placeholderColor'}>
              Already have an account?
            </Text>
            <Text fontSize={16} fontWeight="700" color={'$primary'}>
              Log in
            </Text>
          </YStack>
        </Button>
      </YStack>
    </YStack>
  )
}
