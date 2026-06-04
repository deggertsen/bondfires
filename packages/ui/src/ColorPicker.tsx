import { bondfireColors } from '@bondfires/config'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'

// Approved accent palette from campBranding.ts
const ACCENT_PALETTE = [
  '#FF6B35',
  '#E63946',
  '#F4A261',
  '#2A9D8F',
  '#264653',
  '#6C63FF',
  '#E9C46A',
  '#457B9D',
  '#1D3557',
  '#A8DADC',
] as const

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
}

function ColorCircle({
  color,
  selected,
  onSelect,
}: {
  color: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Pressable onPress={onSelect}>
      <YStack
        width={40}
        height={40}
        borderRadius={20}
        backgroundColor={color}
        borderWidth={selected ? 3 : 2}
        borderColor={selected ? bondfireColors.whiteSmoke : bondfireColors.iron}
        alignItems="center"
        justifyContent="center"
      >
        {selected ? (
          <YStack
            width={8}
            height={8}
            borderRadius={4}
            backgroundColor={bondfireColors.whiteSmoke}
          />
        ) : null}
      </YStack>
    </Pressable>
  )
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <XStack flexWrap="wrap" gap={10}>
      {ACCENT_PALETTE.map((color) => (
        <ColorCircle
          key={color}
          color={color}
          selected={value === color}
          onSelect={() => onChange(color)}
        />
      ))}
    </XStack>
  )
}
