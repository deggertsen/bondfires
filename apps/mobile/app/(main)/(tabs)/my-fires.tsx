import {
  appActions,
  getBondfireVideoIndex,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { Flame, MessageCircle, Pin, User } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Avatar, Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { routes } from '../../../lib/routes'

type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

type MyFire = Doc<'bondfires'> & {
  camp: Doc<'camps'> | null
  lastActivityAt: number
  unread: boolean
  participants: ThreadParticipant[]
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

function ParticipantStack({ participants }: { participants: ThreadParticipant[] }) {
  return (
    <XStack height={32} alignItems="center">
      {participants.slice(0, 4).map((participant, index) => (
        <Avatar
          key={participant.user._id}
          circular
          size="$2"
          marginLeft={index === 0 ? 0 : -8}
          borderWidth={1}
          borderColor={bondfireColors.obsidian}
        >
          {participant.user.photoUrl ? (
            <Avatar.Image source={{ uri: participant.user.photoUrl }} />
          ) : (
            <Avatar.Fallback backgroundColor={bondfireColors.gunmetal}>
              <User size={14} color={bondfireColors.ash} />
            </Avatar.Fallback>
          )}
        </Avatar>
      ))}
    </XStack>
  )
}

function MyFireRow({ thread, onOpen }: { thread: MyFire; onOpen: () => void }) {
  const responses = Math.max(0, thread.videoCount - 1)
  const participantNames = thread.participants
    .slice(0, 3)
    .map((participant) => participant.user.displayName ?? participant.user.name ?? 'Someone')
    .join(', ')

  return (
    <Pressable onPress={onOpen}>
      <XStack paddingHorizontal={16} paddingVertical={14} gap={12} alignItems="center">
        <YStack
          width={66}
          height={66}
          borderRadius={16}
          backgroundColor={thread.unread ? bondfireColors.bondfireCopper : bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={thread.unread ? bondfireColors.moltenGold : bondfireColors.iron}
          alignItems="center"
          justifyContent="center"
        >
          <Flame
            size={30}
            color={thread.unread ? bondfireColors.obsidian : bondfireColors.bondfireCopper}
          />
          {thread.unread ? (
            <YStack
              position="absolute"
              top={6}
              right={6}
              width={10}
              height={10}
              borderRadius={5}
              backgroundColor={bondfireColors.error}
            />
          ) : null}
        </YStack>

        <YStack flex={1} gap={6}>
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <YStack flex={1} gap={2}>
              <Text fontSize={16} fontWeight="900" numberOfLines={1}>
                {thread.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1}>
                {thread.camp?.name ?? 'Bondfire'} · {getTimeAgo(thread.lastActivityAt)}
              </Text>
            </YStack>

            {thread.unread ? (
              <YStack
                paddingHorizontal={8}
                paddingVertical={4}
                borderRadius={999}
                backgroundColor={bondfireColors.error}
              >
                <Text color={bondfireColors.whiteSmoke} fontSize={10} fontWeight="900">
                  NEW
                </Text>
              </YStack>
            ) : null}
          </XStack>

          <XStack alignItems="center" justifyContent="space-between" gap={12}>
            <XStack alignItems="center" gap={8} flex={1}>
              <ParticipantStack participants={thread.participants} />
              <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1} flex={1}>
                {participantNames}
              </Text>
            </XStack>

            <XStack alignItems="center" gap={5}>
              <MessageCircle size={15} color={bondfireColors.ash} />
              <Text fontSize={12} color={bondfireColors.ash}>
                {responses}
              </Text>
            </XStack>
          </XStack>
        </YStack>
      </XStack>
    </Pressable>
  )
}

export default function MyFiresScreen() {
  const router = useRouter()
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const threads = useQuery(api.conversations.listMyFires, { limit: 80 }) as MyFire[] | undefined

  const unreadCount = useMemo(
    () => threads?.filter((thread) => thread.unread).length ?? 0,
    [threads],
  )

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)
    setTimeout(() => setIsRefreshing(false), 800)
  }, [])

  const handleOpen = useCallback(
    (bondfireId: string) => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      appActions.setVideoMuted(false)
      router.push(routes.bondfire(bondfireId))
    },
    [router],
  )

  if (threads === undefined) {
    return (
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={bondfireColors.bondfireCopper} />
        </YStack>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
      <FlatList
        key={refreshKey}
        data={threads}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={bondfireColors.bondfireCopper}
            colors={[bondfireColors.bondfireCopper]}
          />
        }
        renderItem={({ item }) => <MyFireRow thread={item} onOpen={() => handleOpen(item._id)} />}
        ItemSeparatorComponent={() => (
          <Separator borderColor={bondfireColors.iron} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={62} paddingHorizontal={16} paddingBottom={14} gap={10}>
            <XStack alignItems="center" justifyContent="space-between">
              <YStack gap={2}>
                <Text fontSize={28} fontWeight="900">
                  My Fires
                </Text>
                <Text fontSize={13} color={bondfireColors.ash}>
                  {unreadCount > 0
                    ? `${unreadCount} unread ${unreadCount === 1 ? 'thread' : 'threads'}`
                    : 'All caught up'}
                </Text>
              </YStack>
              <Pin size={22} color={bondfireColors.bondfireCopper} />
            </XStack>
          </YStack>
        }
        ListEmptyComponent={
          <YStack flex={1} alignItems="center" justifyContent="center" paddingHorizontal={40}>
            <Flame size={58} color={bondfireColors.bondfireCopper} />
            <Text fontSize={22} fontWeight="900" marginTop={18} textAlign="center">
              No active fires yet
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center" marginTop={8}>
              Threads appear here once you spark or respond.
            </Text>
            <Button
              variant="primary"
              size="$lg"
              marginTop={24}
              onPress={() => router.push(routes.feed)}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                Browse Feed
              </Text>
            </Button>
          </YStack>
        }
      />
    </YStack>
  )
}
