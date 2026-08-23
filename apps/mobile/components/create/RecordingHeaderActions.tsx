import { Spinner } from '@bondfires/ui'
import { FileText, SwitchCamera } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from '../videoOverlayColors'

interface RecordingHeaderActionsProps {
  onSwitchCamera: () => void
  cameraSwitchDisabled: boolean
  cameraSwitchInProgress?: boolean
  onOpenNotes?: () => void
}

export function RecordingHeaderActions({
  onSwitchCamera,
  cameraSwitchDisabled,
  cameraSwitchInProgress = false,
  onOpenNotes,
}: RecordingHeaderActionsProps) {
  return (
    <XStack gap={12}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Switch camera"
        accessibilityState={{ disabled: cameraSwitchDisabled }}
        onPress={onSwitchCamera}
        disabled={cameraSwitchDisabled}
      >
        <YStack
          width={40}
          height={40}
          borderRadius={20}
          backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
          alignItems="center"
          justifyContent="center"
          opacity={cameraSwitchDisabled ? 0.5 : 1}
        >
          {cameraSwitchInProgress ? (
            <Spinner size="small" color={VIDEO_OVERLAY_COLORS.textPrimary} />
          ) : (
            <SwitchCamera size={22} color={VIDEO_OVERLAY_COLORS.textPrimary} />
          )}
        </YStack>
      </Pressable>

      {onOpenNotes ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open recording notes"
          onPress={onOpenNotes}
        >
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
            alignItems="center"
            justifyContent="center"
          >
            <FileText size={22} color={VIDEO_OVERLAY_COLORS.textPrimary} />
          </YStack>
        </Pressable>
      ) : null}
    </XStack>
  )
}
