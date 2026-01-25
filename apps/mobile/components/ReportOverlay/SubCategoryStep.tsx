import { bondfireColors } from '@bondfires/config'
import { Text } from '@bondfires/ui'
import { ArrowLeft, ChevronRight } from '@tamagui/lucide-icons'
import { Pressable, ScrollView } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { SUBCATEGORIES, type SubCategory, type SubCategoryStepProps } from './types'

export function SubCategoryStep({ onSelect, onBack }: SubCategoryStepProps) {
  return (
    <YStack gap={12}>
      <XStack alignItems="center" gap={8}>
        <Pressable onPress={onBack}>
          <ArrowLeft size={24} color={bondfireColors.whiteSmoke} />
        </Pressable>
        <Text fontSize={18} fontWeight="600" color={bondfireColors.whiteSmoke}>
          Community Guidelines
        </Text>
      </XStack>
      <Text fontSize={14} color={bondfireColors.ash}>
        What type of violation is this?
      </Text>
      <ScrollView style={{ maxHeight: 400 }}>
        <YStack gap={8}>
          {SUBCATEGORIES.map((subCat) => (
            <Pressable
              key={subCat.value}
              onPress={() => onSelect(subCat.value as SubCategory)}
            >
              <XStack
                padding={16}
                backgroundColor={bondfireColors.gunmetal}
                borderRadius={12}
                alignItems="center"
                justifyContent="space-between"
              >
                <Text color={bondfireColors.whiteSmoke}>{subCat.label}</Text>
                <ChevronRight size={20} color={bondfireColors.ash} />
              </XStack>
            </Pressable>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
