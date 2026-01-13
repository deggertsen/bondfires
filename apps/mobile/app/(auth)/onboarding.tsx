import { appActions } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { Flame } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'

export default function OnboardingScreen() {
  const router = useRouter()

  const handleContinue = () => {
    appActions.completeOnboarding()
    router.replace('/(auth)/signup')
  }

  const handleLogin = () => {
    appActions.completeOnboarding()
    router.replace('/(auth)/login')
  }

  return (
    <YStack
      flex={1}
      backgroundColor={bondfireColors.obsidian}
      paddingHorizontal={24}
      paddingVertical={60}
    >
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      <YStack flex={1} justifyContent="center" alignItems="center" gap={40}>
        {/* Logo */}
        <YStack
          width={120}
          height={120}
          borderRadius={60}
          backgroundColor={bondfireColors.gunmetal}
          alignItems="center"
          justifyContent="center"
          borderWidth={3}
          borderColor={bondfireColors.bondfireCopper}
        >
          <Flame size={60} color={bondfireColors.bondfireCopper} />
        </YStack>

        <YStack alignItems="center" gap={12}>
          <Text fontSize={32} fontWeight="800" textAlign="center">
            Welcome to Bondfires
          </Text>
          <Text fontSize={16} color={bondfireColors.ash} textAlign="center" maxWidth={300}>
            Share video moments and respond to others to build meaningful connections.
          </Text>
        </YStack>

        {/* How it works */}
        <YStack gap={24} maxWidth={320} marginTop={20}>
          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.bondfireCopper}
            >
              <Text fontWeight="700" color={bondfireColors.bondfireCopper}>
                1
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16}>
                Spark a Bondfire
              </Text>
              <Text fontSize={14} color={bondfireColors.ash}>
                Record and share a video to start a conversation.
              </Text>
            </YStack>
          </XStack>

          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.moltenGold}
            >
              <Text fontWeight="700" color={bondfireColors.moltenGold}>
                2
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16}>
                Respond to Others
              </Text>
              <Text fontSize={14} color={bondfireColors.ash}>
                Add your video response to keep the bondfire growing.
              </Text>
            </YStack>
          </XStack>

          <XStack gap={16} alignItems="flex-start">
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.deepEmber}
            >
              <Text fontWeight="700" color={bondfireColors.deepEmber}>
                3
              </Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600" fontSize={16}>
                Build Connections
              </Text>
              <Text fontSize={14} color={bondfireColors.ash}>
                Watch bondfires grow as more people join in.
              </Text>
            </YStack>
          </XStack>
        </YStack>
      </YStack>

      <YStack gap={12} marginTop={24}>
        <Button variant="primary" size="$lg" onPress={handleContinue}>
          <Flame size={20} color={bondfireColors.whiteSmoke} />
          <Text color={bondfireColors.whiteSmoke}>Get Started</Text>
        </Button>
        <Button variant="ghost" size="$md" onPress={handleLogin}>
          <Text>Already have an account? Log in</Text>
        </Button>
      </YStack>
    </YStack>
  )
}
