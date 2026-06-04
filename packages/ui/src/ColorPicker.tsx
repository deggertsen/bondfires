import { bondfireColors } from '@bondfires/config'
import { Check } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'

type ColorPickerProps = {
  palette: readonly string[]
  selected: string | undefined
  onSelect: (color: string) => void
}

const DARK_CHECK_SWATCHES = new Set(['#A8DADC', '#E9C46A', '#F4A261'])

export function ColorPicker({ palette, selected, onSelect }: ColorPickerProps) {
  const selectedColor = selected?.toUpperCase()

  return (
    <XStack flexWrap="wrap" gap={10}>
      {palette.map((color) => {
        const normalizedColor = color.toUpperCase()
        const isSelected = selectedColor === normalizedColor
        const checkColor = DARK_CHECK_SWATCHES.has(normalizedColor)
          ? bondfireColors.charcoal
          : bondfireColors.whiteSmoke

        return (
          <Pressable
            key={color}
            accessibilityLabel={`Accent color ${color}`}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            hitSlop={6}
            onPress={() => onSelect(color)}
          >
            <YStack
              width={40}
              height={40}
              borderRadius={20}
              backgroundColor={color}
              borderWidth={isSelected ? 3 : 2}
              borderColor={isSelected ? bondfireColors.whiteSmoke : bondfireColors.iron}
              alignItems="center"
              justifyContent="center"
            >
              {isSelected ? <Check size={18} color={checkColor} strokeWidth={3} /> : null}
            </YStack>
          </Pressable>
        )
      })}
    </XStack>
  )
}
