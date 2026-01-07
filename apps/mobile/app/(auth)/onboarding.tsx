import { useRouter } from 'expo-router'
import { YStack, XStack, Text, H1, Paragraph } from 'tamagui'
import { Button, Container } from '@bondfires/ui'
import { appActions } from '@bondfires/app'

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
    <Container padded safe>
      <YStack flex={1} justifyContent="center" alignItems="center" gap="$6">
        {/* Logo/Icon placeholder */}
        <YStack
          width={120}
          height={120}
          borderRadius={60}
          backgroundColor="$orange10"
          alignItems="center"
          justifyContent="center"
        >
          <Text fontSize={60}>🔥</Text>
        </YStack>
        
        <YStack alignItems="center" gap="$3">
          <H1 textAlign="center">Welcome to Bondfires</H1>
          <Paragraph textAlign="center" color="$gray11" maxWidth={300}>
            Share video moments and respond to others to build meaningful connections.
          </Paragraph>
        </YStack>
        
        {/* How it works */}
        <YStack gap="$4" maxWidth={320} marginTop="$4">
          <XStack gap="$3" alignItems="flex-start">
            <YStack
              width={32}
              height={32}
              borderRadius={16}
              backgroundColor="$orange5"
              alignItems="center"
              justifyContent="center"
            >
              <Text fontWeight="bold" color="$orange10">1</Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600">Spark a Bondfire</Text>
              <Text fontSize="$2" color="$gray11">
                Record and share a video to start a conversation.
              </Text>
            </YStack>
          </XStack>
          
          <XStack gap="$3" alignItems="flex-start">
            <YStack
              width={32}
              height={32}
              borderRadius={16}
              backgroundColor="$orange5"
              alignItems="center"
              justifyContent="center"
            >
              <Text fontWeight="bold" color="$orange10">2</Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600">Respond to Others</Text>
              <Text fontSize="$2" color="$gray11">
                Add your video response to keep the bondfire growing.
              </Text>
            </YStack>
          </XStack>
          
          <XStack gap="$3" alignItems="flex-start">
            <YStack
              width={32}
              height={32}
              borderRadius={16}
              backgroundColor="$orange5"
              alignItems="center"
              justifyContent="center"
            >
              <Text fontWeight="bold" color="$orange10">3</Text>
            </YStack>
            <YStack flex={1}>
              <Text fontWeight="600">Build Connections</Text>
              <Text fontSize="$2" color="$gray11">
                Watch bondfires grow as more people join in.
              </Text>
            </YStack>
          </XStack>
        </YStack>
      </YStack>
      
      <YStack gap="$3" marginTop="$6">
        <Button variant="primary" size="lg" onPress={handleContinue}>
          Get Started
        </Button>
        <Button variant="ghost" size="md" onPress={handleLogin}>
          Already have an account? Log in
        </Button>
      </YStack>
    </Container>
  )
}

