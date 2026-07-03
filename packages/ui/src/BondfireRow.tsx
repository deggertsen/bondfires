import { Flame, Mail, MessageCircle, User } from '@tamagui/lucide-icons'
import { Image } from 'expo-image'
import { Pressable } from 'react-native'
import { Avatar, XStack, YStack } from 'tamagui'
import { Button } from './Button'
import { type SwipeAction, SwipeableRow } from './SwipeableRow'
import { Text } from './Text'

export type BondfireParticipant = {
  userId: string
  displayName?: string
  photoUrl?: string
}

export type BondfireRowProps = {
  /** Bondfire title (falls back to creatorName if absent) */
  title?: string
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
  /** Status label displayed after the timestamp, e.g. "Viewed" or "New" */
  statusLabel: string
  /** Optional priority badge computed by the backend */
  badge?: 'sparked' | 'invited' | null
  /** Participant avatars to show */
  participants: BondfireParticipant[]
  /** Swipe actions revealed by swiping LEFT (destructive / admin) */
  actions: SwipeAction[]
  /** Swipe actions revealed by swiping RIGHT (e.g. Edit — owner only) */
  rightActions?: SwipeAction[]
  /** Callbacks */
  onOpen: () => void
  onRespond: () => void
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

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
            <Avatar.Fallback
              backgroundColor="$backgroundHover"
              alignItems="center"
              justifyContent="center"
            >
              <User size={14} color="$placeholderColor" />
            </Avatar.Fallback>
          )}
        </Avatar>
      ))}
    </XStack>
  )
}

function BondfireBadge({ badge }: { badge: NonNullable<BondfireRowProps['badge']> }) {
  const isInvited = badge === 'invited'
  const Icon = isInvited ? Mail : Flame
  const label = isInvited ? 'Invited' : 'Sparked'
  const color = isInvited ? '$secondary' : '$primary'

  return (
    <XStack
      alignItems="center"
      gap={4}
      paddingHorizontal={8}
      paddingVertical={3}
      borderRadius={8}
      backgroundColor="$backgroundHover"
      borderWidth={1}
      borderColor={color}
    >
      <Icon size={12} color={color} />
      <Text fontSize={11} fontWeight="900" color={color} numberOfLines={1}>
        {label}
      </Text>
    </XStack>
  )
}

export function BondfireRow({
  title,
  creatorName,
  timestamp,
  videoCount,
  campLabel,
  thumbnailUrl,
  isLive,
  statusLabel,
  badge,
  participants,
  actions,
  rightActions,
  onOpen,
  onRespond,
}: BondfireRowProps) {
  const timeAgo = getTimeAgo(timestamp)
  const responses = Math.max(0, videoCount - 1)
  const subtitle = isLive ? 'Live now' : `${timeAgo} · ${statusLabel}`
  const displayTitle = title?.trim() || `${creatorName ?? 'Anonymous'}'s Bondfire`

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
                {displayTitle}
              </Text>
              <Text fontSize={12} color="$placeholderColor" numberOfLines={1}>
                {creatorName ? `${creatorName} · ${subtitle}` : subtitle}
              </Text>
            </YStack>

            <Button variant="outline" size="$sm" onPress={onRespond} borderColor="$primary">
              <Text color="$color" fontWeight="800">
                Respond
              </Text>
            </Button>
          </XStack>

          <XStack alignItems="center" gap={14}>
            {badge ? <BondfireBadge badge={badge} /> : null}
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

  return (
    <SwipeableRow actions={actions} rightActions={rightActions}>
      {row}
    </SwipeableRow>
  )
}
