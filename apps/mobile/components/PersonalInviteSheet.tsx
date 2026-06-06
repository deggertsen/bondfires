import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { Check, Copy, Share, X } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import { useCallback, useState } from 'react'
import { Alert, Pressable, Share as RNShare } from 'react-native'
import { Sheet, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

interface Props {
  bondfireId: Id<'bondfires'>
  open: boolean
  onClose: () => void
}

export function PersonalInviteSheet({ bondfireId, open, onClose }: Props) {
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const createInvite = useMutation(api.personalBondfires.createInvite)

  const generateInvite = useCallback(async () => {
    setLoading(true)
    try {
      const result = await createInvite({ bondfireId })
      setInviteCode(result.code)
      setExpiresAt(result.expiresAt)
    } catch (error) {
      Alert.alert('Error', String(error))
    } finally {
      setLoading(false)
    }
  }, [bondfireId, createInvite])

  // Auto-generate when sheet opens
  if (open && !inviteCode && !loading) {
    generateInvite()
  }

  const handleCopy = useCallback(() => {
    if (!inviteCode) return
    // Use Clipboard
    const { Clipboard } = require('expo-clipboard')
    Clipboard.setStringAsync(inviteCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [inviteCode])

  const handleShare = useCallback(() => {
    if (!inviteCode) return
    const expiresStr = expiresAt
      ? new Date(expiresAt).toLocaleDateString()
      : '7 days'
    RNShare.share({
      message: `Join my Personal Bondfire! Use invite code: ${inviteCode}\n\nExpires: ${expiresStr}\n\nOpen the Bondfires app and enter this code to join.`,
    })
  }, [inviteCode, expiresAt])

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose()
      }}
      snapPoints={[55]}
      dismissOnSnapToBottom
    >
      <Sheet.Frame
        backgroundColor={bondfireColors.charcoal}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        padding={24}
      >
        <YStack gap={20}>
          {/* Handle */}
          <XStack justifyContent="center">
            <YStack
              width={40}
              height={4}
              borderRadius={2}
              backgroundColor={bondfireColors.iron}
            />
          </XStack>

          <Text fontSize={22} fontWeight="900" textAlign="center">
            Invite Someone
          </Text>
          <Text fontSize={14} color={bondfireColors.ash} textAlign="center" lineHeight={20}>
            Personal Bondfires aren't discoverable. Share this invite code so someone can join your
            fire.
          </Text>

          {loading ? (
            <YStack alignItems="center" paddingVertical={24} gap={12}>
              <Spinner size="large" color={bondfireColors.bondfireCopper} />
              <Text color={bondfireColors.ash}>Generating invite...</Text>
            </YStack>
          ) : inviteCode ? (
            <YStack gap={16} alignItems="center">
              {/* Code display */}
              <YStack
                backgroundColor={bondfireColors.gunmetal}
                borderWidth={1}
                borderColor={bondfireColors.iron}
                borderRadius={14}
                paddingHorizontal={24}
                paddingVertical={16}
                alignItems="center"
                gap={8}
              >
                <Text fontSize={12} color={bondfireColors.ash} fontWeight="600" textTransform="uppercase" letterSpacing={1}>
                  Your Invite Code
                </Text>
                <Text fontSize={32} fontWeight="900" letterSpacing={2} color={bondfireColors.whiteSmoke}>
                  {inviteCode}
                </Text>
                {expiresAt && (
                  <Text fontSize={12} color={bondfireColors.ash}>
                    Expires {new Date(expiresAt).toLocaleDateString()}
                  </Text>
                )}
              </YStack>

              {/* Actions */}
              <XStack gap={12} width="100%">
                <Button
                  variant="outline"
                  flex={1}
                  onPress={handleCopy}
                  icon={
                    copied ? (
                      <Check size={18} color={bondfireColors.success} />
                    ) : (
                      <Copy size={18} color={bondfireColors.whiteSmoke} />
                    )
                  }
                >
                  <Text color={copied ? bondfireColors.success : bondfireColors.whiteSmoke} fontWeight="700">
                    {copied ? 'Copied' : 'Copy'}
                  </Text>
                </Button>
                <Button
                  variant="primary"
                  flex={1}
                  onPress={handleShare}
                  icon={<Share size={18} color={bondfireColors.whiteSmoke} />}
                >
                  <Text color={bondfireColors.whiteSmoke} fontWeight="700">
                    Share
                  </Text>
                </Button>
              </XStack>
            </YStack>
          ) : (
            <YStack alignItems="center" paddingVertical={24}>
              <Button variant="primary" onPress={generateInvite}>
                <Text color={bondfireColors.whiteSmoke} fontWeight="700">
                  Generate Invite
                </Text>
              </Button>
            </YStack>
          )}

          <Pressable onPress={onClose} style={{ alignSelf: 'center' }}>
            <YStack
              width={40}
              height={40}
              borderRadius={20}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
            >
              <X size={20} color={bondfireColors.ash} />
            </YStack>
          </Pressable>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}
