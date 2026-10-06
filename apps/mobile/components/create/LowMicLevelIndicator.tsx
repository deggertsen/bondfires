import { Text } from '@bondfires/ui'
import { Mic } from '@tamagui/lucide-icons'
import { XStack } from 'tamagui'

export function LowMicLevelIndicator() {
  return (
    <XStack
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      alignItems="center"
      gap={8}
      marginHorizontal={20}
      marginBottom={14}
      paddingHorizontal={12}
      paddingVertical={8}
      borderRadius={12}
      backgroundColor="$background"
      borderColor="$warning"
      borderWidth={1}
    >
      <Mic size={18} color="$warning" />
      <Text color="$color" fontSize={13} flexShrink={1}>
        It's hard to hear you — try speaking closer to the mic.
      </Text>
    </XStack>
  )
}
