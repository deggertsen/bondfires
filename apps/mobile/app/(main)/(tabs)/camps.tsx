import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { Flame, Lock, Search, Users } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { type RelativePathString, useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Separator, Sheet, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'

type CampWithMembership = Doc<'camps'> & {
  membership: Doc<'campMembers'> | null
}
type CampListItem =
  | { type: 'section'; id: string; title: string; subtitle: string }
  | { type: 'camp'; camp: CampWithMembership }

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

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <YStack paddingHorizontal={16} paddingTop={18} paddingBottom={8} gap={3}>
      <Text fontSize={13} color={bondfireColors.bondfireCopper} fontWeight="900">
        {title}
      </Text>
      <Text fontSize={12} color={bondfireColors.ash}>
        {subtitle}
      </Text>
    </YStack>
  )
}

export default function CampsScreen() {
  const router = useRouter()
  const camps = useQuery(api.camps.list, {})
  const joinCamp = useMutation(api.camps.join)
  const createPrivateCamp = useMutation(api.camps.createPrivateCamp)
  const redeemInvite = useMutation(api.camps.redeemInvite)
  const [query, setQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isCreatePrivateOpen, setIsCreatePrivateOpen] = useState(false)
  const [isRedeemInviteOpen, setIsRedeemInviteOpen] = useState(false)
  const [privateCampName, setPrivateCampName] = useState('')
  const [privateCampPurpose, setPrivateCampPurpose] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

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

  const listItems = useMemo<CampListItem[]>(() => {
    if (!filtered) return []

    const privateCamps = filtered.filter((camp) => camp.visibility === 'private')
    const publicCamps = filtered.filter((camp) => camp.visibility !== 'private')
    const items: CampListItem[] = []

    if (privateCamps.length > 0) {
      items.push({
        type: 'section',
        id: 'private',
        title: 'Private',
        subtitle: 'Invite-only camps you belong to.',
      })
      items.push(...privateCamps.map((camp) => ({ type: 'camp' as const, camp })))
    }

    if (publicCamps.length > 0) {
      items.push({
        type: 'section',
        id: 'public',
        title: 'Public',
        subtitle: 'Open and approval-based camps.',
      })
      items.push(...publicCamps.map((camp) => ({ type: 'camp' as const, camp })))
    }

    return items
  }, [filtered])

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

  const handleCreatePrivateCamp = useCallback(async () => {
    const name = privateCampName.trim()
    if (name.length < 3) {
      Alert.alert('Name Required', 'Give your private camp a name first.')
      return
    }

    setIsSubmitting(true)
    try {
      const campId = await createPrivateCamp({
        name,
        purpose: privateCampPurpose.trim() || undefined,
      })
      setPrivateCampName('')
      setPrivateCampPurpose('')
      setIsCreatePrivateOpen(false)
      router.push(`/(main)/camp/${campId}` as RelativePathString)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create private camp'
      Alert.alert('Private Camp Unavailable', message)
    } finally {
      setIsSubmitting(false)
    }
  }, [createPrivateCamp, privateCampName, privateCampPurpose, router])

  const handleRedeemInvite = useCallback(async () => {
    const code = inviteCode.trim().toLowerCase()
    if (!code) {
      Alert.alert('Invite Required', 'Enter an invite code first.')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await redeemInvite({ code })
      setInviteCode('')
      setIsRedeemInviteOpen(false)
      router.push(`/(main)/camp/${result.campId}` as RelativePathString)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to redeem invite'
      Alert.alert('Invite Unavailable', message)
    } finally {
      setIsSubmitting(false)
    }
  }, [inviteCode, redeemInvite, router])

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
        data={listItems}
        keyExtractor={(item) => (item.type === 'section' ? item.id : item.camp._id)}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={bondfireColors.bondfireCopper}
            colors={[bondfireColors.bondfireCopper]}
          />
        }
        renderItem={({ item }) =>
          item.type === 'section' ? (
            <SectionHeader title={item.title} subtitle={item.subtitle} />
          ) : (
            <CampCard
              camp={item.camp}
              onOpen={() => router.push(`/(main)/camp/${item.camp._id}` as RelativePathString)}
              onJoin={() => handleJoin(item.camp)}
            />
          )
        }
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

            <XStack gap={10}>
              <Button
                variant="secondary"
                size="$sm"
                flex={1}
                onPress={() => setIsCreatePrivateOpen(true)}
              >
                <Lock size={15} color={bondfireColors.whiteSmoke} />
                <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                  Private Camp
                </Text>
              </Button>
              <Button
                variant="outline"
                size="$sm"
                flex={1}
                onPress={() => setIsRedeemInviteOpen(true)}
              >
                <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                  Redeem Invite
                </Text>
              </Button>
            </XStack>

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

      <Sheet
        modal
        open={isCreatePrivateOpen}
        onOpenChange={setIsCreatePrivateOpen}
        snapPoints={[48]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
        <Sheet.Frame padding={20} backgroundColor={bondfireColors.charcoal} gap={16}>
          <Sheet.Handle backgroundColor={bondfireColors.iron} />
          <YStack gap={6}>
            <Text fontSize={22} fontWeight="900">
              Create Private Camp
            </Text>
            <Text fontSize={14} color={bondfireColors.ash} lineHeight={20}>
              Owner-led and invite-only. You spark; members respond.
            </Text>
          </YStack>
          <YStack gap={10}>
            <Input
              value={privateCampName}
              onChangeText={setPrivateCampName}
              placeholder="Camp name"
            />
            <Input
              value={privateCampPurpose}
              onChangeText={setPrivateCampPurpose}
              placeholder="Purpose, theme, or focus"
            />
          </YStack>
          <Button
            variant="primary"
            size="$lg"
            disabled={isSubmitting}
            onPress={handleCreatePrivateCamp}
          >
            {isSubmitting ? (
              <Spinner color={bondfireColors.whiteSmoke} />
            ) : (
              <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                Create Camp
              </Text>
            )}
          </Button>
        </Sheet.Frame>
      </Sheet>

      <Sheet
        modal
        open={isRedeemInviteOpen}
        onOpenChange={setIsRedeemInviteOpen}
        snapPoints={[34]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
        <Sheet.Frame padding={20} backgroundColor={bondfireColors.charcoal} gap={16}>
          <Sheet.Handle backgroundColor={bondfireColors.iron} />
          <YStack gap={6}>
            <Text fontSize={22} fontWeight="900">
              Redeem Invite
            </Text>
            <Text fontSize={14} color={bondfireColors.ash} lineHeight={20}>
              Enter the three-word code from the camp owner.
            </Text>
          </YStack>
          <Input
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="none"
            placeholder="amber-canyon-fox"
          />
          <Button variant="primary" size="$lg" disabled={isSubmitting} onPress={handleRedeemInvite}>
            {isSubmitting ? (
              <Spinner color={bondfireColors.whiteSmoke} />
            ) : (
              <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                Join Camp
              </Text>
            )}
          </Button>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  )
}
