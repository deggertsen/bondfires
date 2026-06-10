import { Button, Text } from '@bondfires/ui'
import { Check, Copy, Share, UserPlus, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, Share as RNShare } from 'react-native'
import { Avatar, Sheet, XStack, YStack } from 'tamagui'
import type { Id } from '../../../convex/_generated/dataModel'
import { api } from '../../../convex/_generated/api'

// ── Constants ──────────────────────────────────────────────────────────────

const INVITE_BASE_URL = 'https://bondfires.app/invite'

type InviteMode = 'bondfire' | 'personal-bondfire' | 'camp'

interface Props {
  mode: InviteMode
  /** The parent entity ID — bondfire or camp */
  id: string
  /** Optional title override for the sheet */
  title?: string
  open: boolean
  onClose: () => void
}

// ── Component ──────────────────────────────────────────────────────────────

export function InviteSheet({ mode, id, title, open, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [inviteSent, setInviteSent] = useState<Record<string, boolean>>({})

  // Lazy-load or generate invite code
  const existingCode = useQuery(api.inviteCodes.getInviteCode, { parentType: mode, parentId: id })
  const generateCode = useMutation(api.inviteCodes.generateInviteCode)

  useEffect(() => {
    if (open && existingCode) {
      setCode(existingCode.code)
    }
  }, [open, existingCode])

  useEffect(() => {
    if (open && existingCode === null) {
      // Lazy generate
      generateCode({ parentType: mode, parentId: id, expiresInDays: 7 })
        .then((result) => setCode(result.code))
        .catch(() => {}) // Silently fail, code section just won't show
    }
  }, [open, existingCode, generateCode, mode, id])

  // ── In-app contacts ──────────────────────────────────────────────────

  const contacts = useQuery(api.bondfireInvites.listInvitableContacts, {}) ?? []
  const sendInvite = useMutation(api.bondfireInvites.sendBondfireInvite)

  const handleSendInvite = useCallback(
    async (recipientId: Id<'users'>) => {
      try {
        await sendInvite({ bondfireId: id as Id<'bondfires'>, recipientId })
        setInviteSent((prev) => ({ ...prev, [recipientId]: true }))
      } catch (error) {
        Alert.alert('Invite Failed', error instanceof Error ? error.message : String(error))
      }
    },
    [sendInvite, id],
  )

  // ── Link sharing ─────────────────────────────────────────────────────

  const shareUrl = code
    ? `${INVITE_BASE_URL}/camp/${code}` // camp invites use /camp/ prefix
    : mode === 'camp'
      ? `${INVITE_BASE_URL}/camp/${id}`
      : `${INVITE_BASE_URL}/${id}`

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
        message: `Join me on Bondfires!\n\n${shareUrl}`,
        url: shareUrl,
      })
    } catch {
      // User cancelled
    }
  }, [shareUrl])

  // ── Title ────────────────────────────────────────────────────────────

  const sheetTitle =
    title ??
    (mode === 'camp'
      ? 'Invite to Camp'
      : mode === 'personal-bondfire'
        ? 'Invite to Your Fire'
        : 'Share Bondfire')

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose()
      }}
      snapPoints={[60]}
      dismissOnSnapToBottom
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame
        backgroundColor={'$backgroundPress'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        padding={24}
      >
        <YStack gap={16} flex={1}>
          <Sheet.Handle backgroundColor={'$borderColor'} />

          {/* Title + Close */}
          <XStack justifyContent="space-between" alignItems="center">
            <Text fontSize={20} fontWeight="900">
              {sheetTitle}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={'$placeholderColor'} />
            </Pressable>
          </XStack>

          {/* ── In-app contacts ─────────────────────────────────────── */}
          {contacts.length > 0 && (
            <YStack gap={12}>
              <Text fontSize={13} fontWeight="700" color={'$placeholderColor'} textTransform="uppercase" letterSpacing={1}>
                Invite People
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <XStack gap={12} paddingRight={16}>
                  {contacts.map((contact) => {
                    const sent = inviteSent[contact._id]
                    const hasPhoto = !!contact.photoUrl
                    const initial = ((contact.displayName ?? contact.name ?? '?')[0] ?? '?').toUpperCase()

                    return (
                      <Pressable
                        key={contact._id}
                        onPress={() => !sent && handleSendInvite(contact._id)}
                        disabled={sent}
                      >
                        <YStack alignItems="center" gap={6} width={64}>
                          <Avatar size={52} borderRadius={26}>
                            {hasPhoto && <Avatar.Image source={{ uri: contact.photoUrl! }} />}
                            <Avatar.Fallback backgroundColor={sent ? '$green10Light' : '$orange8Light'}>
                              {sent ? (
                                <Check size={22} color="$green10Dark" />
                              ) : (
                                <Text fontSize={20} fontWeight="700" color="$orange11Dark">
                                  {initial}
                                </Text>
                              )}
                            </Avatar.Fallback>
                          </Avatar>
                          <Text fontSize={11} textAlign="center" numberOfLines={1} color={sent ? '$placeholderColor' : '$color'}>
                            {contact.displayName ?? contact.name ?? 'Unknown'}
                          </Text>
                        </YStack>
                      </Pressable>
                    )
                  })}
                </XStack>
              </ScrollView>
            </YStack>
          )}

          {/* ── Share Link ──────────────────────────────────────────── */}
          <YStack gap={12}>
            <Text fontSize={13} fontWeight="700" color={'$placeholderColor'} textTransform="uppercase" letterSpacing={1}>
              Share Link
            </Text>
            <YStack
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$borderColor'}
              borderRadius={14}
              paddingHorizontal={16}
              paddingVertical={12}
              alignItems="center"
              gap={4}
              width="100%"
            >
              <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1} textAlign="center">
                {shareUrl}
              </Text>
            </YStack>
            <XStack gap={12} width="100%">
              <Button
                variant="primary"
                flex={1}
                onPress={handleCopyLink}
                icon={
                  copied ? (
                    <Check size={18} />
                  ) : (
                    <Copy size={18} />
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
                icon={<Share size={18} />}
              >
                <Text color={'$color'} fontWeight="700">
                  Share
                </Text>
              </Button>
            </XStack>
          </YStack>

          {/* ── Invite Code Fallback ────────────────────────────────── */}
          {code && (
            <YStack alignItems="center" gap={4} paddingTop={4}>
              <Text fontSize={11} color={'$placeholderColor'} textTransform="uppercase" letterSpacing={1} fontWeight="600">
                Trouble joining? Use this code
              </Text>
              <Text fontSize={20} fontWeight="900" letterSpacing={1.5} numberOfLines={1}>
                {code}
              </Text>
            </YStack>
          )}
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}
