import { Button, Text } from '@bondfires/ui'
import { Check, Copy, Share } from '@tamagui/lucide-icons'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useState } from 'react'
import { Alert, Pressable, Share as RNShare } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import type { Id } from '../../../convex/_generated/dataModel'

const INVITE_BASE_URL = 'https://bondfires.app/invite'

interface Props {
  bondfireId: Id<'bondfires'>
  open: boolean
  onClose: () => void
}

export function InviteSheet({ bondfireId, open, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const shareUrl = `${INVITE_BASE_URL}/${bondfireId}`

  const handleCopyLink = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      Alert.alert('Copy Failed', error instanceof Error ? error.message : String(error))
    }
  }, [shareUrl])

  const handleShareSheet = useCallback(async () => {
    try {
      await RNShare.share({
        message: `Watch this Bondfire!\n\n${shareUrl}`,
        url: shareUrl,
      })
    } catch {
      // User cancelled — fine
    }
  }, [shareUrl])

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose()
      }}
      snapPoints={[45]}
      dismissOnSnapToBottom
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame
        backgroundColor={'$backgroundPress'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        padding={24}
      >
        <YStack gap={20} flex={1}>
          <Sheet.Handle backgroundColor={'$borderColor'} />

          <Text fontSize={22} fontWeight="900" textAlign="center">
            Share Bondfire
          </Text>

          <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={20}>
            Share this link so others can watch and respond to your Bondfire.
          </Text>

          {/* Share URL Display */}
          <YStack
            backgroundColor={'$backgroundHover'}
            borderWidth={1}
            borderColor={'$borderColor'}
            borderRadius={14}
            paddingHorizontal={24}
            paddingVertical={16}
            alignItems="center"
            gap={8}
            width="100%"
          >
            <Text
              fontSize={12}
              color={'$placeholderColor'}
              fontWeight="600"
              textTransform="uppercase"
              letterSpacing={1}
            >
              Share Link
            </Text>
            <Text fontSize={13} color={'$placeholderColor'} numberOfLines={2} textAlign="center">
              {shareUrl}
            </Text>
          </YStack>

          {/* Actions */}
          <XStack gap={12} width="100%">
            <Button
              variant="primary"
              flex={1}
              onPress={handleCopyLink}
              icon={
                copied ? (
                  <Check size={18} color={'$success'} />
                ) : (
                  <Copy size={18} color={'$color'} />
                )
              }
            >
              <Text color={copied ? '$success' : '$color'} fontWeight="700">
                {copied ? 'Copied' : 'Copy Link'}
              </Text>
            </Button>
            <Button
              variant="outline"
              flex={1}
              onPress={handleShareSheet}
              icon={<Share size={18} color={'$color'} />}
            >
              <Text color={'$color'} fontWeight="700">
                Share
              </Text>
            </Button>
          </XStack>

          {/* Skip / Close */}
          <Pressable onPress={onClose}>
            <Text
              fontSize={14}
              color={'$placeholderColor'}
              textAlign="center"
              fontWeight="600"
              paddingVertical={8}
            >
              Skip
            </Text>
          </Pressable>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}
