import { Button, Text } from '@bondfires/ui'
import { Check, Copy, Share, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, Share as RNShare, ScrollView } from 'react-native'
import { Avatar, Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

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
  const inviteTargetKey = `${mode}:${id}`
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [isGeneratingCode, setIsGeneratingCode] = useState(false)
  const [inviteSent, setInviteSent] = useState<Record<string, boolean>>({})
  const hasRequestedCodeRef = useRef(false)

  const createCampInvite = useMutation(api.camps.createInvite)
  const createPersonalInvite = useMutation(api.personalBondfires.createInvite)

  useEffect(() => {
    void inviteTargetKey
    setCopied(false)
    setCode(null)
    setInviteSent({})
    hasRequestedCodeRef.current = false
  }, [inviteTargetKey])

  useEffect(() => {
    if (open) return
    setCopied(false)
    setIsGeneratingCode(false)
    if (!code) {
      hasRequestedCodeRef.current = false
    }
  }, [code, open])

  useEffect(() => {
    // hasRequestedCodeRef is the single-fire guard. Do NOT gate on (or depend
    // on) code/isGeneratingCode: those are state this effect itself sets, so
    // listing them as deps made the effect re-run the instant we set
    // isGeneratingCode(true). The re-run's cleanup flipped `cancelled` to true
    // and orphaned the in-flight mutation before it resolved — leaving the
    // sheet stuck on "Generating invite..." forever.
    if (!open || mode === 'bondfire' || hasRequestedCodeRef.current) {
      return
    }

    let cancelled = false
    hasRequestedCodeRef.current = true
    setIsGeneratingCode(true)

    const createInvite =
      mode === 'camp'
        ? createCampInvite({ campId: id as Id<'camps'> })
        : createPersonalInvite({ bondfireId: id as Id<'bondfires'> })

    createInvite
      .then((result) => {
        if (!cancelled) {
          setCode(result.code)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          Alert.alert('Invite Failed', error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsGeneratingCode(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, mode, id, createCampInvite, createPersonalInvite])

  // ── In-app contacts ──────────────────────────────────────────────────

  const contacts =
    useQuery(api.bondfireInvites.listInvitableContacts, mode === 'bondfire' ? {} : 'skip') ?? []
  const sendInvite = useMutation(api.bondfireInvites.sendBondfireInvite)

  const handleSendInvite = useCallback(
    async (recipientId: Id<'users'>) => {
      try {
        if (mode !== 'bondfire') return
        await sendInvite({ bondfireId: id as Id<'bondfires'>, recipientId })
        setInviteSent((prev) => ({ ...prev, [recipientId]: true }))
      } catch (error) {
        Alert.alert('Invite Failed', error instanceof Error ? error.message : String(error))
      }
    },
    [sendInvite, id, mode],
  )

  // ── Link sharing ─────────────────────────────────────────────────────

  const shareUrl =
    mode === 'bondfire'
      ? `${INVITE_BASE_URL}/${id}`
      : code
        ? `${INVITE_BASE_URL}${mode === 'camp' ? '/camp' : ''}/${code}`
        : null

  const handleCopyLink = useCallback(async () => {
    if (!shareUrl) return
    try {
      await Clipboard.setStringAsync(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      Alert.alert('Copy Failed', error instanceof Error ? error.message : String(error))
    }
  }, [shareUrl])

  const handleShareSheet = useCallback(async () => {
    if (!shareUrl) return
    try {
      await RNShare.share({
        message: `Join my Bondfire!\n\n${shareUrl}`,
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
          {mode === 'bondfire' && contacts.length > 0 && (
            <YStack gap={12}>
              <Text
                fontSize={13}
                fontWeight="700"
                color={'$placeholderColor'}
                textTransform="uppercase"
                letterSpacing={1}
              >
                Invite People
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <XStack gap={12} paddingRight={16}>
                  {contacts.map((contact) => {
                    const sent = inviteSent[contact._id]
                    const photoUrl = contact.photoUrl
                    const initial = (
                      (contact.displayName ?? contact.name ?? '?')[0] ?? '?'
                    ).toUpperCase()

                    return (
                      <Pressable
                        key={contact._id}
                        onPress={() => !sent && handleSendInvite(contact._id)}
                        disabled={sent}
                      >
                        <YStack alignItems="center" gap={6} width={64}>
                          <Avatar size={52} borderRadius={26}>
                            {photoUrl ? <Avatar.Image source={{ uri: photoUrl }} /> : null}
                            <Avatar.Fallback
                              backgroundColor={sent ? '$green10Light' : '$orange8Light'}
                            >
                              {sent ? (
                                <Check size={22} color="$green10Dark" />
                              ) : (
                                <Text fontSize={20} fontWeight="700" color="$orange11Dark">
                                  {initial}
                                </Text>
                              )}
                            </Avatar.Fallback>
                          </Avatar>
                          <Text
                            fontSize={11}
                            textAlign="center"
                            numberOfLines={1}
                            color={sent ? '$placeholderColor' : '$color'}
                          >
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
            <Text
              fontSize={13}
              fontWeight="700"
              color={'$placeholderColor'}
              textTransform="uppercase"
              letterSpacing={1}
            >
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
                {shareUrl ??
                  (isGeneratingCode ? 'Generating invite...' : 'Invite link unavailable')}
              </Text>
            </YStack>
            <XStack gap={12} width="100%">
              <Button
                variant="primary"
                flex={1}
                onPress={handleCopyLink}
                disabled={!shareUrl}
                icon={copied ? <Check size={18} /> : <Copy size={18} />}
              >
                <Text color={copied ? '$success' : '$color'} fontWeight="700">
                  {copied ? 'Copied' : 'Copy Link'}
                </Text>
              </Button>
              <Button
                variant="outline"
                flex={1}
                onPress={handleShareSheet}
                disabled={!shareUrl}
                icon={<Share size={18} />}
              >
                <Text color={'$color'} fontWeight="700">
                  Share
                </Text>
              </Button>
            </XStack>
          </YStack>

          {/* ── Invite Code Fallback ────────────────────────────────── */}
          {mode !== 'bondfire' && code && (
            <YStack alignItems="center" gap={4} paddingTop={4}>
              <Text
                fontSize={11}
                color={'$placeholderColor'}
                textTransform="uppercase"
                letterSpacing={1}
                fontWeight="600"
              >
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
