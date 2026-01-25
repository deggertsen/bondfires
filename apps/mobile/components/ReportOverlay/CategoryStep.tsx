import { bondfireColors } from '@bondfires/config'
import { Text } from '@bondfires/ui'
import { ChevronRight } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { CATEGORIES, type Category, type CategoryStepProps } from './types'

export function CategoryStep({ onSelect }: CategoryStepProps) {
  return (
    <YStack gap={12}>
      <Text fontSize={18} fontWeight="600" color={bondfireColors.whiteSmoke}>
        Report Video
      </Text>
      <Text fontSize={14} color={bondfireColors.ash}>
        Why are you reporting this video?
      </Text>
      <YStack gap={8}>
        {CATEGORIES.map((cat) => (
          <Pressable
            key={cat.value}
            onPress={() => onSelect(cat.value as Category)}
          >
            <XStack
              padding={16}
              backgroundColor={bondfireColors.gunmetal}
              borderRadius={12}
              alignItems="center"
              justifyContent="space-between"
            >
              <Text color={bondfireColors.whiteSmoke}>{cat.label}</Text>
              <ChevronRight size={20} color={bondfireColors.ash} />
            </XStack>
          </Pressable>
        ))}
      </YStack>
    </YStack>
  )
}
