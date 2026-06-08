import { getRandomCompletionMessage } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { Check, Share } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StatusBar, useColorScheme } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { Id } from '../../../convex/_generated/dataModel'
import { routes } from '../lib/routes'
import { InviteSheet } from './InviteSheet'

interface CompletionScreenProps {
  onContinue?: () => void
  detail?: string
  /** If provided, shows a Share button and auto-opens the InviteSheet */
  shareBondfireId?: Id<'bondfires'>
}

export function CompletionScreen({ detail, onContinue, shareBondfireId }: CompletionScreenProps) {
  const colorScheme = useColorScheme()
  const router = useRouter()
  const [message] = useState(() => getRandomCompletionMessage())
  const [isInviteSheetOpen, setIsInviteSheetOpen] = useState(!!shareBondfireId)

  const handleContinue = () => {
    if (onContinue) {
      onContinue()
    } else {
      router.replace(routes.feed)
    }
  }

  return (
    <>
      <YStack
        flex={1}
        backgroundColor={colorScheme === 'light' ? '#FAFAFA' : '#141416'}
        alignItems="center"
        justifyContent="center"
        padding={32}
      >
        <StatusBar
          barStyle={colorScheme === 'light' ? 'dark-content' : 'light-content'}
          backgroundColor={colorScheme === 'light' ? '#FAFAFA' : '#141416'}
        />

        {/* Large emoji */}
        <Text fontSize={120} marginBottom={32}>
          {message.emoji}
        </Text>

        {/* Congratulatory message */}
        <Text
          fontSize={24}
          fontWeight="700"
          color={'$color'}
          textAlign="center"
          marginBottom={detail ? 16 : 48}
        >
          {message.message}
        </Text>

        {detail && (
          <Text
            color={'$placeholderColor'}
            fontSize={15}
            lineHeight={22}
            textAlign="center"
            marginBottom={40}
          >
            {detail}
          </Text>
        )}

        {/* Buttons */}
        {shareBondfireId ? (
          <XStack gap={12}>
            <Button
              variant="outline"
              size="$lg"
              onPress={() => setIsInviteSheetOpen(true)}
              icon={<Share size={18} color={'$color'} />}
            >
              <Text color={'$color'} fontWeight="700">
                Share
              </Text>
            </Button>
            <Button variant="primary" size="$lg" onPress={handleContinue} icon={Check}>
              <Text color={'$color'}>Continue</Text>
            </Button>
          </XStack>
        ) : (
          <Button variant="primary" size="$lg" onPress={handleContinue} icon={Check}>
            <Text color={'$color'}>Continue</Text>
          </Button>
        )}
      </YStack>

      {/* Invite Sheet */}
      {shareBondfireId && (
        <InviteSheet
          bondfireId={shareBondfireId}
          open={isInviteSheetOpen}
          onClose={() => setIsInviteSheetOpen(false)}
        />
      )}
    </>
  )
}
