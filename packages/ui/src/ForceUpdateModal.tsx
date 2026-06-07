import { bondfireColors } from '@bondfires/config'
import { ArrowUpCircle } from '@tamagui/lucide-icons'
import { useState } from 'react'
import { Modal, Platform, StyleSheet } from 'react-native'
import { YStack } from 'tamagui'
import { Button } from './Button'
import { Text } from './Text'

export interface ForceUpdateModalProps {
  /** Whether the modal is visible. */
  visible: boolean
  /** The minimum required app version. */
  minRequiredVersion: string
  /** The current installed version. */
  currentVersion: string
  /** Called when the user taps "Update Now" — should open the app store. */
  onUpdate: () => void
}

export function ForceUpdateModal({
  visible,
  minRequiredVersion,
  currentVersion,
  onUpdate,
}: ForceUpdateModalProps) {
  const [updating, setUpdating] = useState(false)
  const storeName = Platform.OS === 'ios' ? 'App Store' : 'Play Store'

  const handleUpdate = () => {
    setUpdating(true)
    onUpdate()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Don't allow dismissing — forced update
      onRequestClose={() => {}}
    >
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        paddingHorizontal={32}
        gap={24}
        style={StyleSheet.absoluteFill}
      >
        {/* Icon */}
        <ArrowUpCircle size={64} color={bondfireColors.bondfireCopper} />

        {/* Title */}
        <YStack gap={4} alignItems="center">
          <Text fontSize={28} fontWeight="700" color={bondfireColors.whiteSmoke} textAlign="center">
            Update Required
          </Text>
          <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
            A new version of Bondfires is available. You must update to continue using the app.
          </Text>
        </YStack>

        {/* Version info */}
        <YStack
          backgroundColor={bondfireColors.gunmetal}
          borderRadius={12}
          paddingHorizontal={20}
          paddingVertical={12}
          gap={8}
          width="100%"
          maxWidth={280}
          alignItems="center"
        >
          <YStack flexDirection="row" gap={8} alignItems="center">
            <Text fontSize={13} color={bondfireColors.ash}>
              Your version:
            </Text>
            <Text fontSize={13} fontWeight="600" color={bondfireColors.error}>
              {currentVersion}
            </Text>
          </YStack>
          <YStack flexDirection="row" gap={8} alignItems="center">
            <Text fontSize={13} color={bondfireColors.ash}>
              Required:
            </Text>
            <Text fontSize={13} fontWeight="600" color={bondfireColors.success}>
              {minRequiredVersion}
            </Text>
          </YStack>
        </YStack>

        {/* Update button */}
        <Button
          variant="primary"
          width="100%"
          maxWidth={280}
          size="$lg"
          onPress={handleUpdate}
          disabled={updating}
          icon={<ArrowUpCircle size={20} color={bondfireColors.whiteSmoke} />}
        >
          {updating ? `Opening ${storeName}...` : `Update on ${storeName}`}
        </Button>

        {/* Footer text */}
        <Text fontSize={12} color={bondfireColors.slate} textAlign="center">
          You'll be redirected to the {storeName} to download the latest version.
        </Text>
      </YStack>
    </Modal>
  )
}
