import { ArrowUpCircle, Download, RefreshCw } from '@tamagui/lucide-icons'
import { useState } from 'react'
import { Modal, Platform, StyleSheet } from 'react-native'
import { Spinner, YStack } from 'tamagui'
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
  onStartUpdate: () => void | Promise<void>
}

export function ForceUpdateModal({
  visible,
  minRequiredVersion,
  currentVersion,
  updatePriority,
  downloading,
  updateReady,
  onStartUpdate,
}: ForceUpdateModalProps) {
  const [starting, setStarting] = useState(false)

  const isFlexible = updatePriority === 'flexible' && Platform.OS === 'android'
  const storeLabel = Platform.OS === 'ios' ? 'App Store' : 'Play Store'

  if (isFlexible && downloading && !updateReady) {
    return null
  }

  // ----------------------------------------------------------
  // Render: Flexible download complete — Play Core is finishing install
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
          backgroundColor="$background"
          alignItems="center"
          justifyContent="center"
          paddingHorizontal={32}
          gap={24}
          style={StyleSheet.absoluteFill}
        >
          <RefreshCw size={64} color="$success" />
          <YStack gap={4} alignItems="center">
            <Text fontSize={28} fontWeight="700" color="$gray12" textAlign="center">
              Finishing Update
            </Text>
            <Text fontSize={15} color="$placeholderColor" textAlign="center" lineHeight={22}>
              The update has downloaded. Bondfires will reopen when installation completes.
            </Text>
          </YStack>
          <Spinner size="large" color="$primary" />
          <YStack
            backgroundColor="$backgroundHover"
            borderRadius={12}
            paddingHorizontal={20}
            paddingVertical={12}
            gap={8}
            width="100%"
            maxWidth={280}
            alignItems="center"
          >
            <YStack flexDirection="row" gap={8} alignItems="center">
              <Text fontSize={13} color="$placeholderColor">
                Your version:
              </Text>
              <Text fontSize={13} fontWeight="600" color="$error">
                {currentVersion}
              </Text>
            </YStack>
            <YStack flexDirection="row" gap={8} alignItems="center">
              <Text fontSize={13} color="$placeholderColor">
                New version:
              </Text>
              <Text fontSize={13} fontWeight="600" color="$success">
                {minRequiredVersion}
              </Text>
            </YStack>
          </YStack>
        </YStack>
      </Modal>
    )
  }

  // ----------------------------------------------------------
  // Render: Immediate update (blocking modal with store link)
  // ----------------------------------------------------------
  const handleStart = async () => {
    setStarting(true)
    try {
      await onStartUpdate()
    } finally {
      setStarting(false)
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
        backgroundColor="$background"
        alignItems="center"
        justifyContent="center"
        paddingHorizontal={32}
        gap={24}
        style={StyleSheet.absoluteFill}
      >
        {isFlexible ? (
          <Download size={64} color="$primary" />
        ) : (
          <ArrowUpCircle size={64} color="$primary" />
        )}
        <YStack gap={4} alignItems="center">
          <Text fontSize={28} fontWeight="700" color="$gray12" textAlign="center">
            Update Required
          </Text>
          <Text fontSize={15} color="$placeholderColor" textAlign="center" lineHeight={22}>
            {isFlexible
              ? 'A new version of Bondfires is available. Download it now to continue.'
              : 'A new version of Bondfires is available. You must update to continue using the app.'}
          </Text>
        </YStack>
        <YStack
          backgroundColor="$backgroundHover"
          borderRadius={12}
          paddingHorizontal={20}
          paddingVertical={12}
          gap={8}
          width="100%"
          maxWidth={280}
          alignItems="center"
        >
          <YStack flexDirection="row" gap={8} alignItems="center">
            <Text fontSize={13} color="$placeholderColor">
              Your version:
            </Text>
            <Text fontSize={13} fontWeight="600" color="$error">
              {currentVersion}
            </Text>
          </YStack>
          <YStack flexDirection="row" gap={8} alignItems="center">
            <Text fontSize={13} color="$placeholderColor">
              Required:
            </Text>
            <Text fontSize={13} fontWeight="600" color="$success">
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
          disabled={starting}
          icon={
            isFlexible ? (
              <Download size={20} color="$gray12" />
            ) : (
              <ArrowUpCircle size={20} color="$gray12" />
            )
          }
        >
          {starting ? 'Starting...' : isFlexible ? 'Download Update' : `Update on ${storeLabel}`}
        </Button>
        <Text fontSize={12} color="$placeholderColor" textAlign="center">
          {isFlexible
            ? 'Android will download the update in the background.'
            : `You'll be redirected to the ${storeLabel} to download the latest version.`}
        </Text>
      </YStack>
    </Modal>
  )
}
