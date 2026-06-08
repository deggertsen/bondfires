import { hasViewedToday } from '@bondfires/app'
import { Flame, MessageCircle } from '@tamagui/lucide-icons'
import { Image } from 'expo-image'
import { Pressable } from 'react-native'
import { Avatar, XStack, YStack } from 'tamagui'
import { Button } from './Button'
import { SwipeableRow } from './SwipeableRow'
import { Text } from './Text'

// ── Types ──────────────────────────────────────────────────────

export type BondfireParticipant = {
  userId: string
  displayName?: string
  photoUrl?: string
}

export type BondfireRowProps = {
  /** Bondfire document id */
  id: string
  /** Bondfire creator display name */
  creatorName: string
  /** Timestamp for the time ago display */
  timestamp: number
  /** Total video count (spark + responses) */
  videoCount: number
  /** Camp label to display as a pill, e.g. "Welcome Fires (Men)" */
  campLabel?: string
  /** Thumbnail URL for the spark video */
  thumbnailUrl: string | null
  /** Whether this bondfire is currently live */
  isLive: boolean
  /** The bondfire owner user id */
  ownerId: string
  /** Current authenticated user id */
  currentUserId: string | null
  /** Set of pinned bondfire ids for the current user */
  pinnedIds: string[]
  /** Participant avatars to show */
  participants: BondfireParticipant[]
  /** Callbacks */
  onOpen: () => void
  onRespond: () => void
  onDelete: () => void
  onPin: () => void
  onUnpin: () => void
  onReport: () => void
}

// ── Helpers ────────────────────────────────────────────────────

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

// ── Sub-components ─────────────────────────────────────────────

function ParticipantStack({ participants }: { participants: BondfireParticipant[] }) {
  return (
    <XStack height={28} alignItems="center">
      {participants.slice(0, 4).map((participant, index) => (
        <Avatar
          key={participant.userId}
          circular
          size="$1.5"
          marginLeft={index === 0 ? 0 : -8}
          borderWidth={1}
          borderColor="$background"
        >
          {participant.photoUrl ? (
            <Avatar.Image source={{ uri: participant.photoUrl }} />
          ) : (
            <Avatar.Fallback backgroundColor="$backgroundHover" />
          )}
        </Avatar>
      ))}
    </XStack>
  )
}

// ── Main Component ─────────────────────────────────────────────

export function BondfireRow({
  id,
  creatorName,
  timestamp,
  videoCount,
  campLabel,
  thumbnailUrl,
  isLive,
  ownerId,
  currentUserId,
  pinnedIds,
  participants,
  onOpen,
  onRespond,
  onDelete,
  onPin,
  onUnpin,
  onReport,
}: BondfireRowProps) {
  const timeAgo = getTimeAgo(timestamp)
  const responses = Math.max(0, videoCount - 1)
  const viewed = hasViewedToday(id)
  const isOwner = currentUserId === ownerId
  const isPinned = pinnedIds.includes(id)

  const actions: Array<{
    key: string
    label: string
    color?: string
    backgroundColor?: string
    onPress: () => void
  }> = []

  if (isOwner) {
    actions.push({
      key: 'delete',
      label: 'Delete',
      color: '$color',
      backgroundColor: '$errorDark',
      onPress: onDelete,
    })
  } else {
    actions.push({
      key: 'report',
      label: 'Report',
      color: '$warning',
      backgroundColor: '$backgroundHover',
      onPress: onReport,
    })
  }

  actions.push({
    key: 'pin',
    label: isPinned ? 'Unpin' : 'Pin',
    color: '$primary',
    backgroundColor: '$backgroundHover',
    onPress: isPinned ? onUnpin : onPin,
  })

  const row = (
    <Pressable onPress={onOpen}>
      <XStack
        paddingHorizontal={16}
        paddingVertical={12}
        gap={12}
        alignItems="center"
        backgroundColor="$background"
      >
        {/* Thumbnail */}
        <YStack
          width={74}
          height={74}
          borderRadius={16}
          overflow="hidden"
          backgroundColor="$backgroundHover"
          borderWidth={1}
          borderColor="$borderColor"
          alignItems="center"
          justifyContent="center"
        >
          {thumbnailUrl ? (
            <Image
              source={{ uri: thumbnailUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <Flame size={30} color="$primary" />
          )}
          {isLive && (
            <YStack
              position="absolute"
              top={6}
              left={6}
              backgroundColor="$error"
              paddingHorizontal={7}
              paddingVertical={3}
              borderRadius={10}
            >
              <Text color="$color" fontSize={9} fontWeight="900">
                LIVE
              </Text>
            </YStack>
          )}
        </YStack>

        {/* Content */}
        <YStack flex={1} gap={6}>
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <YStack flex={1} gap={2}>
              <Text fontSize={16} fontWeight="900" numberOfLines={1}>
                {creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={12} color="$placeholderColor" numberOfLines={1}>
                {isLive ? 'Live now' : `${timeAgo} · ${viewed ? 'Viewed' : 'New'}`}
              </Text>
            </YStack>

            <Button variant="outline" size="$sm" onPress={onRespond} borderColor="$primary">
              <Text color="$color" fontWeight="800">
                Respond
              </Text>
            </Button>
          </XStack>

          <XStack alignItems="center" gap={14}>
            {participants.length > 0 ? <ParticipantStack participants={participants} /> : null}
            <XStack alignItems="center" gap={6}>
              <MessageCircle size={16} color="$placeholderColor" />
              <Text fontSize={13} color="$placeholderColor">
                {responses} {responses === 1 ? 'response' : 'responses'}
              </Text>
            </XStack>
            {campLabel ? (
              <YStack
                flexShrink={1}
                maxWidth="55%"
                paddingHorizontal={8}
                paddingVertical={3}
                borderRadius={8}
                backgroundColor="$backgroundHover"
                borderWidth={1}
                borderColor="$borderColor"
              >
                <Text fontSize={11} fontWeight="800" color="$primary" numberOfLines={1}>
                  {campLabel}
                </Text>
              </YStack>
            ) : null}
          </XStack>
        </YStack>
      </XStack>
    </Pressable>
  )

  return <SwipeableRow actions={actions}>{row}</SwipeableRow>
}
