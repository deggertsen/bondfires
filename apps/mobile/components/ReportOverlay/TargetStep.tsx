import { Button, Text } from '@bondfires/ui'
import { ShieldAlert, UserRoundX } from '@tamagui/lucide-icons'
import { YStack } from 'tamagui'
import type { ReportTarget } from './types'

export function TargetStep({
  onSelect,
  onBlock,
}: {
  onSelect: (target: ReportTarget) => void
  onBlock: () => void
}) {
  return (
    <YStack gap={16}>
      <Text fontSize={20} fontWeight="700" textAlign="center">
        What would you like to report?
      </Text>
      <Button
        variant="outline"
        size="$lg"
        onPress={() => onSelect('content')}
        accessibilityLabel="Report this video"
      >
        <ShieldAlert size={20} color={'$warning'} />
        <Text>Report this video</Text>
      </Button>
      <Button
        variant="destructive"
        size="$lg"
        onPress={onBlock}
        accessibilityLabel="Block this user without submitting a report"
      >
        <UserRoundX size={20} color={'$color'} />
        <Text>Block user</Text>
      </Button>
      <Button
        variant="outline"
        size="$lg"
        onPress={() => onSelect('user')}
        accessibilityLabel="Report this user"
      >
        <UserRoundX size={20} color={'$warning'} />
        <Text>Report this user</Text>
      </Button>
    </YStack>
  )
}
