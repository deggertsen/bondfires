import { Button, Text } from '@bondfires/ui'
import { CheckCircle } from '@tamagui/lucide-icons'
import { YStack } from 'tamagui'
import type { SuccessStepProps } from './types'

export function SuccessStep({ onClose, onBlock, isBlocking }: SuccessStepProps) {
  return (
    <YStack gap={16} alignItems="center" padding={20}>
      <YStack
        width={64}
        height={64}
        borderRadius={32}
        backgroundColor={'$success'}
        alignItems="center"
        justifyContent="center"
      >
        <CheckCircle size={32} color={'$color'} />
      </YStack>
      <Text fontSize={18} fontWeight="600" color={'$color'} textAlign="center">
        Thank You
      </Text>
      <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
        Thanks for helping us keep our community safe! We'll review your report and take appropriate
        action.
      </Text>
      {onBlock ? (
        <Button
          variant="destructive"
          size="$lg"
          onPress={onBlock}
          disabled={isBlocking}
          width="100%"
          accessibilityLabel="Block this user"
        >
          <Text color={'$color'} fontWeight="600">
            {isBlocking ? 'Blocking…' : 'Block this user'}
          </Text>
        </Button>
      ) : null}
      <Button variant="primary" size="$lg" onPress={onClose} width="100%">
        <Text color={'$color'} fontWeight="600">
          Done
        </Text>
      </Button>
    </YStack>
  )
}
