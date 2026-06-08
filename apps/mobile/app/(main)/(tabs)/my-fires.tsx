import {
  appActions,
  appStore$,
  getBondfireVideoIndex,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  useAppThemeColors,
} from '@bondfires/app'
import { Button, SwipeableRow, Text } from '@bondfires/ui'
import { Flame, MessageCircle, Pin, User } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Avatar, Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { useValue } from '@legendapp/state/react'
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
          borderColor={'$background'}
        >
          {participant.user.photoUrl ? (
            <Avatar.Image source={{ uri: participant.user.photoUrl }} />
          ) : (
            <Avatar.Fallback backgroundColor={'$backgroundHover'}>
              <User size={14} color={'$placeholderColor'} />
            </Avatar.Fallback>
          )}
        </Avatar>
      ))}
    </XStack>
  )
}

function MyFireRow({
  thread,
  currentUserId,
  pinnedIds,
  onOpen,
  onDelete,
  onPin,
  onUnpin,
  onReport,
}: {
  thread: MyFire
  currentUserId: string | null
  pinnedIds: string[]
  onOpen: () => void
  onDelete: () => void
  onPin: () => void
  onUnpin: () => void
  onReport: () => void
}) {
  const responses = Math.max(0, thread.videoCount - 1)
  const participantNames = thread.participants
    .slice(0, 3)
    .map((participant) => participant.user.displayName ?? participant.user.name ?? 'Someone')
    .join(', ')
  const isOwner = currentUserId === thread.userId
  const isPinned = pinnedIds.includes(thread._id)

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
      <XStack paddingHorizontal={16} paddingVertical={14} gap={12} alignItems="center">
        <YStack
          width={66}
          height={66}
          borderRadius={16}
          backgroundColor={thread.unread ? '$primary' : '$backgroundHover'}
          borderWidth={1}
          borderColor={thread.unread ? '$secondary' : '$borderColor'}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={30} color={thread.unread ? '$background' : '$primary'} />
          {thread.unread ? (
            <YStack
              position="absolute"
              top={6}
              right={6}
              width={10}
              height={10}
              borderRadius={5}
              backgroundColor={'$error'}
            />
          ) : null}
        </YStack>

        <YStack flex={1} gap={6}>
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <YStack flex={1} gap={2}>
              <Text fontSize={16} fontWeight="900" numberOfLines={1}>
                {thread.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                {thread.camp?.name ?? 'Bondfire'} · {getTimeAgo(thread.lastActivityAt)}
              </Text>
            </YStack>

            {thread.unread ? (
              <YStack
                paddingHorizontal={8}
                paddingVertical={4}
                borderRadius={999}
                backgroundColor={'$error'}
              >
                <Text color={'$color'} fontSize={10} fontWeight="900">
                  NEW
                </Text>
              </YStack>
            ) : null}
          </XStack>

          <XStack alignItems="center" justifyContent="space-between" gap={12}>
            <XStack alignItems="center" gap={8} flex={1}>
              <ParticipantStack participants={thread.participants} />
              <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1} flex={1}>
                {participantNames}
              </Text>
            </XStack>

            <XStack alignItems="center" gap={5}>
              <MessageCircle size={15} color={'$placeholderColor'} />
              <Text fontSize={12} color={'$placeholderColor'}>
                {responses}
              </Text>
            </XStack>
          </XStack>
        </YStack>
      </XStack>
    </Pressable>
  )

  return <SwipeableRow actions={actions}>{row}</SwipeableRow>
}

export default function MyFiresScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const threads = useQuery(api.conversations.listMyFires, { limit: 80 }) as MyFire[] | undefined

  // Swipe action mutations
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)
  const currentUserId = useValue(appStore$.userId)

  // Pinned bondfire IDs from user doc
  const currentUser = useQuery(api.users.current, currentUserId ? {} : 'skip')
  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )

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

  const handleDelete = useCallback(
    (bondfireId: string) => {
      Alert.alert(
        'Delete Bondfire',
        'This will permanently remove your bondfire and all responses. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
                setRefreshKey((current) => current + 1)
              } catch (error) {
                Alert.alert('Error', 'Failed to delete bondfire. Please try again.')
              }
            },
          },
        ],
      )
    },
    [deleteBondfire],
  )

  const handlePin = useCallback(
    async (bondfireId: string) => {
      try {
        await pinBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
        setRefreshKey((current) => current + 1)
      } catch (error) {
        Alert.alert('Error', String(error))
      }
    },
    [pinBondfire],
  )

  const handleUnpin = useCallback(
    async (bondfireId: string) => {
      try {
        await unpinBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
        setRefreshKey((current) => current + 1)
      } catch (error) {
        Alert.alert('Error', String(error))
      }
    },
    [unpinBondfire],
  )

  const handleReport = useCallback(
    (bondfireId: string, videoOwnerId: string) => {
      Alert.alert(
        'Report Content',
        'What category best describes the issue?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Harassment',
            onPress: async () => {
              try {
                await reportBondfire({
                  bondfireId: bondfireId as Id<'bondfires'>,
                  videoOwnerId: videoOwnerId as Id<'users'>,
                  category: 'community_guidelines',
                  subCategory: 'harassment_or_abuse',
                  comments: 'Reported from My Fires swipe action',
                })
                Alert.alert('Reported', 'Thank you. We will review this content.')
              } catch (error) {
                Alert.alert('Error', String(error))
              }
            },
          },
          {
            text: 'Inappropriate',
            onPress: async () => {
              try {
                await reportBondfire({
                  bondfireId: bondfireId as Id<'bondfires'>,
                  videoOwnerId: videoOwnerId as Id<'users'>,
                  category: 'community_guidelines',
                  subCategory: 'pornographic_content',
                  comments: 'Reported from My Fires swipe action',
                })
                Alert.alert('Reported', 'Thank you. We will review this content.')
              } catch (error) {
                Alert.alert('Error', String(error))
              }
            },
          },
          {
            text: 'Spam',
            onPress: async () => {
              try {
                await reportBondfire({
                  bondfireId: bondfireId as Id<'bondfires'>,
                  videoOwnerId: videoOwnerId as Id<'users'>,
                  category: 'community_guidelines',
                  subCategory: 'spam_or_solicitation',
                  comments: 'Reported from My Fires swipe action',
                })
                Alert.alert('Reported', 'Thank you. We will review this content.')
              } catch (error) {
                Alert.alert('Error', String(error))
              }
            },
          },
        ],
      )
    },
    [reportBondfire],
  )

  if (threads === undefined) {
    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={'$primary'} />
        </YStack>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <FlatList
        key={refreshKey}
        data={threads}
        extraData={currentUserId}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        renderItem={({ item }) => (
          <MyFireRow
            thread={item}
            currentUserId={currentUserId}
            pinnedIds={pinnedIds}
            onOpen={() => handleOpen(item._id)}
            onDelete={() => handleDelete(item._id)}
            onPin={() => handlePin(item._id)}
            onUnpin={() => handleUnpin(item._id)}
            onReport={() => handleReport(item._id, item.userId)}
          />
        )}
        ItemSeparatorComponent={() => (
          <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={62} paddingHorizontal={16} paddingBottom={14} gap={10}>
            <XStack alignItems="center" justifyContent="space-between">
              <YStack gap={2}>
                <Text fontSize={28} fontWeight="900">
                  My Fires
                </Text>
                <Text fontSize={13} color={'$placeholderColor'}>
                  {unreadCount > 0
                    ? `${unreadCount} unread ${unreadCount === 1 ? 'thread' : 'threads'}`
                    : 'All caught up'}
                </Text>
              </YStack>
              <Pin size={22} color={'$primary'} />
            </XStack>
          </YStack>
        }
        ListEmptyComponent={
          <YStack flex={1} alignItems="center" justifyContent="center" paddingHorizontal={40}>
            <Flame size={58} color={'$primary'} />
            <Text fontSize={22} fontWeight="900" marginTop={18} textAlign="center">
              No active fires yet
            </Text>
            <Text fontSize={15} color={'$placeholderColor'} textAlign="center" marginTop={8}>
              Threads appear here once you spark or respond.
            </Text>
            <Button
              variant="primary"
              size="$lg"
              marginTop={24}
              onPress={() => router.push(routes.feed)}
            >
              <Text color={'$color'} fontWeight="900">
                Browse Feed
              </Text>
            </Button>
          </YStack>
        }
      />
    </YStack>
  )
}
