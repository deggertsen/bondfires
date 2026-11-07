import { Text } from '@bondfires/ui'
import { XStack, YStack } from 'tamagui'

/** The camp's own guidelines, shown on the camp page and its join gate. */
export function CampGuidelinesCard({ guidelines }: { guidelines: readonly string[] | undefined }) {
  const lines = (guidelines ?? []).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null
  return (
    <YStack
      padding={14}
      borderRadius={16}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
      gap={8}
    >
      <Text fontSize={12} color={'$placeholderColor'} fontWeight="900">
        CAMP GUIDELINES
      </Text>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: guidelines can repeat; the list is static and position is its identity
        <XStack key={`${index}-${line}`} gap={8}>
          <Text fontSize={14} color={'$placeholderColor'} fontWeight="800" width={18}>
            {index + 1}.
          </Text>
          <Text fontSize={14} color={'$color'} lineHeight={20} flex={1}>
            {line}
          </Text>
        </XStack>
      ))}
    </YStack>
  )
}
