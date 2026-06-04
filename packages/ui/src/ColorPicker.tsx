import { bondfireColors } from '@bondfires/config'
import { Pressable } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'

type ColorPickerProps = {
  palette: readonly string[]
  selected: string | undefined
  onSelect: (color: string) => void
}

export function ColorPicker({ palette, selected, onSelect }: ColorPickerProps) {
  return (
    <XStack flexWrap="wrap" gap={10}>
      {palette.map((color) => {
        const isSelected = selected?.toUpperCase() === color.toUpperCase()
        return (
          <Pressable key={color} onPress={() => onSelect(color)}>
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
              {isSelected ? (
                <Text
                  fontSize={16}
                  fontWeight="900"
                  color={
                    color.toUpperCase() === '#A8DADC' ||
                    color.toUpperCase() === '#E9C46A' ||
                    color.toUpperCase() === '#F4A261'
                      ? bondfireColors.charcoal
                      : bondfireColors.whiteSmoke
                  }
                  lineHeight={18}
                >
                  ✓
                </Text>
              ) : null}
            </YStack>
          </Pressable>
        )
      })}
    </XStack>
  )
}
