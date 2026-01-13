import { getRandomCompletionMessage } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { Check } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StatusBar } from 'react-native'
import { YStack } from 'tamagui'

interface CompletionScreenProps {
  onContinue?: () => void
}

export function CompletionScreen({ onContinue }: CompletionScreenProps) {
  const router = useRouter()
  const [message] = useState(() => getRandomCompletionMessage())

  const handleContinue = () => {
    if (onContinue) {
      onContinue()
    } else {
      router.replace('/(main)/feed')
    }
  }

  return (
    <YStack
      flex={1}
      backgroundColor={bondfireColors.obsidian}
      alignItems="center"
      justifyContent="center"
      padding={32}
    >
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      {/* Large emoji */}
      <Text fontSize={120} marginBottom={32}>
        {message.emoji}
      </Text>

      {/* Congratulatory message */}
      <Text
        fontSize={24}
        fontWeight="700"
        color={bondfireColors.whiteSmoke}
        textAlign="center"
        marginBottom={48}
      >
        {message.message}
      </Text>

      {/* Continue button */}
      <Button variant="primary" size="$lg" onPress={handleContinue} icon={Check}>
        <Text color={bondfireColors.whiteSmoke}>Continue</Text>
      </Button>
    </YStack>
  )
}
