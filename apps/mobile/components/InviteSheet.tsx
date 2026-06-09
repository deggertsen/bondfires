import { Button, Spinner, Text } from '@bondfires/ui'
import { Check, Copy, Send, Share, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useState } from 'react'
import { Alert, FlatList, Pressable, Share as RNShare } from 'react-native'
import { Separator, Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

const INVITE_BASE_URL = 'https://bondfires.app/invite'

interface Props {
  bondfireId: Id<'bondfires'>
  open: boolean
  onClose: () => void
}

type Tab = 'contacts' | 'link'

export function InviteSheet({ bondfireId, open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('contacts')
  const [copied, setCopied] = useState(false)
  const [sentIds, setSentIds] = useState<Set<string>>(new Set())

  const contacts = useQuery(api.bondfireInvites.listInvitableContacts, {})
  const sendInvite = useMutation(api.bondfireInvites.sendBondfireInvite)

  // Generate a share link for the bondfire
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

  const handleShareLink = useCallback(async () => {
    try {
      await RNShare.share({
        message: `Watch this Bondfire!\n\n${shareUrl}`,
        url: shareUrl,
      })
    } catch {
      // User cancelled share — that's fine, not an error
    }
  }, [shareUrl])

  const handleSendToContact = useCallback(
    async (recipientId: Id<'users'>) => {
      try {
        await sendInvite({ bondfireId, recipientId })
        setSentIds((prev) => new Set(prev).add(recipientId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        Alert.alert('Invite Failed', message)
      }
    },
    [bondfireId, sendInvite],
  )

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose()
      }}
      snapPoints={[70]}
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

          {/* Tab Bar */}
          <XStack backgroundColor={'$backgroundHover'} borderRadius={12} padding={4} gap={4}>
            <Pressable onPress={() => setTab('contacts')} style={{ flex: 1 }}>
              <YStack
                paddingVertical={10}
                alignItems="center"
                borderRadius={10}
                backgroundColor={tab === 'contacts' ? '$primary' : 'transparent'}
              >
                <Text
                  fontSize={14}
                  fontWeight="700"
                  color={tab === 'contacts' ? '$color' : '$placeholderColor'}
                >
                  In-App
                </Text>
              </YStack>
            </Pressable>
            <Pressable onPress={() => setTab('link')} style={{ flex: 1 }}>
              <YStack
                paddingVertical={10}
                alignItems="center"
                borderRadius={10}
                backgroundColor={tab === 'link' ? '$primary' : 'transparent'}
              >
                <Text
                  fontSize={14}
                  fontWeight="700"
                  color={tab === 'link' ? '$color' : '$placeholderColor'}
                >
                  Share Link
                </Text>
              </YStack>
            </Pressable>
          </XStack>

          {tab === 'contacts' ? (
            <YStack flex={1}>
              {contacts === undefined ? (
                <YStack alignItems="center" paddingVertical={24}>
                  <Spinner size="large" color={'$primary'} />
                </YStack>
              ) : contacts.length === 0 ? (
                <YStack alignItems="center" paddingVertical={32} gap={8}>
                  <Text color={'$placeholderColor'} fontSize={14} textAlign="center">
                    No contacts yet.
                  </Text>
                  <Text color={'$placeholderColor'} fontSize={12} textAlign="center">
                    People you interact with in camps or bondfires will appear here.
                  </Text>
                </YStack>
              ) : (
                <FlatList
                  data={contacts}
                  keyExtractor={(item) => item._id}
                  ItemSeparatorComponent={() => (
                    <Separator borderColor={'rgba(51, 53, 58, 0.25)'} />
                  )}
                  renderItem={({ item }) => {
                    const sent = sentIds.has(item._id)
                    return (
                      <Pressable
                        onPress={() => !sent && handleSendToContact(item._id as Id<'users'>)}
                      >
                        <XStack paddingVertical={10} gap={12} alignItems="center">
                          <YStack
                            width={40}
                            height={40}
                            borderRadius={20}
                            backgroundColor={'$backgroundHover'}
                            borderWidth={1}
                            borderColor={'$borderColor'}
                            alignItems="center"
                            justifyContent="center"
                          >
                            <Text fontSize={16} fontWeight="800">
                              {(item.displayName ?? item.name ?? '?').charAt(0).toUpperCase()}
                            </Text>
                          </YStack>
                          <Text flex={1} fontSize={15} fontWeight="600">
                            {item.displayName ?? item.name ?? 'Unknown'}
                          </Text>
                          {sent ? (
                            <Text fontSize={13} color={'$success'} fontWeight="700">
                              Sent ✓
                            </Text>
                          ) : (
                            <Button variant="outline" size="small" disabled={sent}>
                              <Send size={14} color={'$color'} />
                            </Button>
                          )}
                        </XStack>
                      </Pressable>
                    )
                  }}
                />
              )}
            </YStack>
          ) : (
            <YStack gap={16} alignItems="center">
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
                <Text
                  fontSize={13}
                  color={'$placeholderColor'}
                  numberOfLines={2}
                  textAlign="center"
                >
                  {shareUrl}
                </Text>
              </YStack>

              <XStack gap={12} width="100%">
                <Button
                  variant="outline"
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
                  variant="primary"
                  flex={1}
                  onPress={handleShareLink}
                  icon={<Share size={18} color={'$color'} />}
                >
                  <Text color={'$color'} fontWeight="700">
                    Share
                  </Text>
                </Button>
              </XStack>
            </YStack>
          )}

          {/* Close button */}
          <Pressable onPress={onClose} style={{ alignSelf: 'center' }}>
            <YStack
              width={40}
              height={40}
              borderRadius={20}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
            >
              <X size={20} color={'$placeholderColor'} />
            </YStack>
          </Pressable>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}
