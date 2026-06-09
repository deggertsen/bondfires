import { Text } from '@bondfires/ui'
import { ChevronRight } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { CATEGORIES, type Category, type CategoryStepProps } from './types'

export function CategoryStep({ onSelect }: CategoryStepProps) {
  return (
    <YStack gap={12}>
      <Text fontSize={18} fontWeight="600" color={'$color'}>
        Report Video
      </Text>
      <Text fontSize={14} color={'$placeholderColor'}>
        Why are you reporting this video?
      </Text>
      <YStack gap={8}>
        {CATEGORIES.map((cat) => (
          <Pressable key={cat.value} onPress={() => onSelect(cat.value as Category)}>
            <XStack
              padding={16}
              backgroundColor={'$backgroundHover'}
              borderRadius={12}
              alignItems="center"
              justifyContent="space-between"
            >
              <Text color={'$color'}>{cat.label}</Text>
              <ChevronRight size={20} color={'$placeholderColor'} />
            </XStack>
          </Pressable>
        ))}
      </YStack>
    </YStack>
  )
}
