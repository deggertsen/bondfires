import { appActions, appStore$ } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { Pressable, StyleSheet } from 'react-native'
import { Slider, Text, XStack, YStack } from 'tamagui'

// Settings popover always uses a dark overlay background regardless of theme.
// This keeps it visually anchored as a floating control panel.
const POPOVER_BG = 'rgba(0, 0, 0, 0.9)'
const POPOVER_TEXT = '#F3F4F6'

interface SettingsPopoverProps {
  onClose: () => void
}

export function SettingsPopover({ onClose }: SettingsPopoverProps) {
  const playbackSpeed = useValue(appStore$.preferences.playbackSpeed)

  const handleSpeedChange = (value: number) => {
    // Round to nearest 0.25 increment (1.0, 1.25, 1.5, 1.75, 2.0)
    const rounded = Math.round(value * 4) / 4
    appActions.setPlaybackSpeed(rounded)
  }

  return (
    <>
      {/* Backdrop to close on tap outside */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

      {/* Popover container */}
      <YStack
        position="absolute"
        top={94}
        right={16}
        width={200}
        padding={16}
        backgroundColor={POPOVER_BG}
        borderRadius={8}
        zIndex={1000}
      >
        <Text fontSize={14} fontWeight="600" color={POPOVER_TEXT} marginBottom={12}>
          Playback Speed
        </Text>
        <XStack alignItems="center" gap={8}>
          <YStack flex={1}>
            <Slider
              value={[playbackSpeed]}
              onValueChange={([value]) => handleSpeedChange(value)}
              min={1.0}
              max={2.0}
              step={0.25}
              width="100%"
              height={40}
            >
              <Slider.Track>
                <Slider.TrackActive backgroundColor={'$primary'} />
              </Slider.Track>
              <Slider.Thumb index={0} circular backgroundColor={'$primary'} />
            </Slider>
          </YStack>
          <Text fontSize={14} color={POPOVER_TEXT} minWidth={40}>
            {playbackSpeed.toFixed(2)}x
          </Text>
        </XStack>
      </YStack>
    </>
  )
}
