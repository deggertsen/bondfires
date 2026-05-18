import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { Flame, Lock, Search, Users } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { type RelativePathString, useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'

type CampWithMembership = Doc<'camps'> & {
  membership: Doc<'campMembers'> | null
}

function getAccessLabel(camp: Doc<'camps'>) {
  if (camp.visibility === 'private') return 'Invite only'
  if (camp.access === 'approval') return 'Approval'
  return 'Open'
}

function getMemberLabel(camp: Doc<'camps'>) {
  const count = camp.activeMemberCount ?? 0
  return [count, count === 1 ? 'member' : 'members'].join(' ')
}

function CampCard({
  camp,
  onOpen,
  onJoin,
}: {
  camp: CampWithMembership
  onOpen: () => void
  onJoin: () => void
}) {
  const isActiveMember = camp.membership?.status === 'active'
  const isPending = camp.membership?.status === 'pending'
  const canJoinFromList = !isActiveMember && !isPending && camp.visibility === 'public'

  return (
    <Pressable onPress={onOpen}>
      <YStack paddingHorizontal={16} paddingVertical={14} gap={12}>
        <XStack alignItems="flex-start" gap={12}>
          <YStack
            width={54}
            height={54}
            borderRadius={16}
            backgroundColor={camp.color ?? bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
          >
            {camp.visibility === 'private' ? (
              <Lock size={25} color={bondfireColors.whiteSmoke} />
            ) : (
              <Flame size={28} color={bondfireColors.whiteSmoke} />
            )}
          </YStack>

          <YStack flex={1} gap={7}>
            <XStack alignItems="center" justifyContent="space-between" gap={10}>
              <YStack flex={1} gap={2}>
                <Text fontSize={17} fontWeight="900" numberOfLines={1}>
                  {camp.name}
                </Text>
                <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1}>
                  {camp.theme ?? getAccessLabel(camp)}
                </Text>
              </YStack>

              {isActiveMember ? (
                <YStack
                  borderRadius={999}
                  paddingHorizontal={10}
                  paddingVertical={5}
                  backgroundColor={bondfireColors.charcoal}
                  borderWidth={1}
                  borderColor={bondfireColors.iron}
                >
                  <Text fontSize={11} color={bondfireColors.whiteSmoke} fontWeight="900">
                    Joined
                  </Text>
                </YStack>
              ) : null}
            </XStack>

            <Text fontSize={14} color={bondfireColors.whiteSmoke} lineHeight={20} numberOfLines={2}>
              {camp.purpose}
            </Text>

            <XStack alignItems="center" justifyContent="space-between" gap={10}>
              <XStack alignItems="center" gap={12} flex={1}>
                <XStack alignItems="center" gap={5}>
                  <Users size={14} color={bondfireColors.ash} />
                  <Text fontSize={12} color={bondfireColors.ash}>
                    {getMemberLabel(camp)}
                  </Text>
                </XStack>
                <Text fontSize={12} color={bondfireColors.ash}>
                  {getAccessLabel(camp)}
                </Text>
              </XStack>

              {canJoinFromList ? (
                <Button variant="outline" size="$sm" onPress={onJoin}>
                  <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                    {camp.access === 'approval' ? 'Request' : 'Join'}
                  </Text>
                </Button>
              ) : null}
              {isPending ? (
                <Text fontSize={12} color={bondfireColors.warning} fontWeight="900">
                  Pending
                </Text>
              ) : null}
            </XStack>
          </YStack>
        </XStack>
      </YStack>
    </Pressable>
  )
}

function EmptyCamps({ hasQuery, onReset }: { hasQuery: boolean; onReset: () => void }) {
  return (
    <YStack paddingVertical={96} paddingHorizontal={32} alignItems="center" gap={14}>
      <Flame size={58} color={bondfireColors.bondfireCopper} />
      <Text fontSize={20} fontWeight="900" textAlign="center">
        {hasQuery ? 'No matching camps' : 'No camps yet'}
      </Text>
      <Text fontSize={14} color={bondfireColors.ash} textAlign="center" lineHeight={21}>
        {hasQuery
          ? 'Try a different search.'
          : 'Seed the launch camps from Convex before opening this surface.'}
      </Text>
      {hasQuery ? (
        <Button variant="outline" size="$md" onPress={onReset}>
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            Clear Search
          </Text>
        </Button>
      ) : null}
    </YStack>
  )
}

export default function CampsScreen() {
  const router = useRouter()
  const camps = useQuery(api.camps.list, {})
  const joinCamp = useMutation(api.camps.join)
  const [query, setQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const filtered = useMemo(() => {
    if (!camps) return camps

    const q = query.trim().toLowerCase()
    if (!q) return camps

    return camps.filter((camp) => {
      const searchable = [camp.name, camp.theme, camp.purpose, camp.defaultPrompt]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchable.includes(q)
    })
  }, [camps, query])

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    setTimeout(() => setIsRefreshing(false), 600)
  }, [])

  const handleJoin = useCallback(
    async (camp: CampWithMembership) => {
      try {
        const result = await joinCamp({ campId: camp._id })
        if (result.status === 'pending') {
          Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to join camp'
        Alert.alert('Camp Unavailable', message)
      }
    },
    [joinCamp],
  )

  if (camps === undefined) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
      >
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
        <Text marginTop={18} color={bondfireColors.ash}>
          Loading camps...
        </Text>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <FlatList
        data={filtered ?? []}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={bondfireColors.bondfireCopper}
            colors={[bondfireColors.bondfireCopper]}
          />
        }
        renderItem={({ item }) => (
          <CampCard
            camp={item}
            onOpen={() => router.push(`/(main)/camp/${item._id}` as RelativePathString)}
            onJoin={() => handleJoin(item)}
          />
        )}
        ItemSeparatorComponent={() => (
          <Separator borderColor={bondfireColors.iron} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={68} paddingBottom={14} paddingHorizontal={16} gap={14}>
            <YStack gap={4}>
              <Text fontSize={28} fontWeight="900">
                Camps
              </Text>
              <Text fontSize={14} color={bondfireColors.ash}>
                Browse the spaces where Bondfires gather.
              </Text>
            </YStack>

            <XStack
              alignItems="center"
              gap={10}
              backgroundColor={bondfireColors.gunmetal}
              borderRadius={14}
              borderWidth={1}
              borderColor={bondfireColors.iron}
              paddingHorizontal={12}
              paddingVertical={10}
            >
              <Search size={18} color={bondfireColors.ash} />
              <Input
                value={query}
                onChangeText={setQuery}
                placeholder="Search camps"
                backgroundColor="transparent"
                borderWidth={0}
                height={22}
                paddingHorizontal={0}
                flex={1}
              />
              <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
                {filtered?.length ?? 0}
              </Text>
            </XStack>
          </YStack>
        }
        ListEmptyComponent={
          <EmptyCamps hasQuery={query.trim().length > 0} onReset={() => setQuery('')} />
        }
        contentContainerStyle={{ paddingBottom: 110 }}
      />
    </YStack>
  )
}
