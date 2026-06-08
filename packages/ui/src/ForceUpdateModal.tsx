import { bondfireColors } from '@bondfires/config'
import { ArrowUpCircle, Download, RefreshCw } from '@tamagui/lucide-icons'
import { useState } from 'react'
import { ActivityIndicator, Modal, Platform, StyleSheet } from 'react-native'
import { YStack } from 'tamagui'
import { Button } from './Button'
import { Text } from './Text'

export type UpdatePriority = 'flexible' | 'immediate'

export interface ForceUpdateModalProps {
  /** Whether the modal is visible. */
  visible: boolean
  /** The minimum required app version. */
  minRequiredVersion: string
  /** The current installed version. */
  currentVersion: string
  /** The update priority from remote config. */
  updatePriority: UpdatePriority | null
  /** True while the flexible update is downloading. */
  downloading: boolean
  /** True when the flexible update has been downloaded and is ready to install. */
  updateReady: boolean
  /** Called when the user taps to start the update. */
  onStartUpdate: () => void
  /** Called when the user taps to restart after flexible download. */
  onInstallUpdate: () => void
}

export function ForceUpdateModal({
  visible,
  minRequiredVersion,
  currentVersion,
  updatePriority,
  downloading,
  updateReady,
  onStartUpdate,
  onInstallUpdate,
}: ForceUpdateModalProps) {
  const [started, setStarted] = useState(false)

  const isFlexible = updatePriority === 'flexible' && Platform.OS === 'android'
  const storeLabel = Platform.OS === 'ios' ? 'App Store' : 'Play Store'

  // ----------------------------------------------------------
  // Render: Flexible download in progress
  // ----------------------------------------------------------
  if (isFlexible && downloading) {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        statusBarTranslucent
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
          <Download size={64} color={bondfireColors.bondfireCopper} />
          <YStack gap={4} alignItems="center">
            <Text fontSize={28} fontWeight="700" color={bondfireColors.whiteSmoke} textAlign="center">
              Downloading Update
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
              A new version is downloading in the background. You can keep using the app.
            </Text>
          </YStack>
          <ActivityIndicator size="large" color={bondfireColors.bondfireCopper} />
          <Text fontSize={13} color={bondfireColors.slate} textAlign="center">
            Version {minRequiredVersion}
          </Text>
        </YStack>
      </Modal>
    )
  }

  // ----------------------------------------------------------
  // Render: Flexible download complete — restart prompt
  // ----------------------------------------------------------
  if (isFlexible && updateReady) {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        statusBarTranslucent
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
          <RefreshCw size={64} color={bondfireColors.success} />
          <YStack gap={4} alignItems="center">
            <Text fontSize={28} fontWeight="700" color={bondfireColors.whiteSmoke} textAlign="center">
              Update Ready
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
              The update has been downloaded. Restart now to apply it.
            </Text>
          </YStack>
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
                New version:
              </Text>
              <Text fontSize={13} fontWeight="600" color={bondfireColors.success}>
                {minRequiredVersion}
              </Text>
            </YStack>
          </YStack>
          <Button
            variant="primary"
            width="100%"
            maxWidth={280}
            size="$lg"
            onPress={onInstallUpdate}
            icon={<RefreshCw size={20} color={bondfireColors.whiteSmoke} />}
          >
            Restart Now
          </Button>
        </YStack>
      </Modal>
    )
  }

  // ----------------------------------------------------------
  // Render: Immediate update (blocking modal with store link)
  // ----------------------------------------------------------
  const handleStart = () => {
    setStarted(true)
    if (isFlexible) {
      // Flexible mode but not yet downloading — kick it off
      onStartUpdate()
    } else {
      // Immediate mode — open the store
      onStartUpdate()
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
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
        <ArrowUpCircle size={64} color={bondfireColors.bondfireCopper} />
        <YStack gap={4} alignItems="center">
          <Text fontSize={28} fontWeight="700" color={bondfireColors.whiteSmoke} textAlign="center">
            Update Required
          </Text>
          <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
            A new version of Bondfires is available. You must update to continue using the app.
          </Text>
        </YStack>
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
        <Button
          variant="primary"
          width="100%"
          maxWidth={280}
          size="$lg"
          onPress={handleStart}
          disabled={started}
          icon={isFlexible ? <Download size={20} color={bondfireColors.whiteSmoke} /> : <ArrowUpCircle size={20} color={bondfireColors.whiteSmoke} />}
        >
          {started
            ? 'Starting...'
            : isFlexible
              ? 'Download Update'
              : `Update on ${storeLabel}`}
        </Button>
        <Text fontSize={12} color={bondfireColors.slate} textAlign="center">
          {isFlexible
            ? 'The update will download in the background.'
            : `You'll be redirected to the ${storeLabel} to download the latest version.`}
        </Text>
      </YStack>
    </Modal>
  )
}
