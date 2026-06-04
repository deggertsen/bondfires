import { parseError, subscriptionActions } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, CampCardStatusBanner, Input, Text } from '@bondfires/ui'
import { ChevronDown, ChevronUp, Flame, Lock, Search, Sparkles, Users } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { type RelativePathString, useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Separator, Sheet, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'

type CampWithMembership = Doc<'camps'> & {
  membership: Doc<'campMembers'> | null
  frozen?: boolean
}
type CampListItem =
  | { type: 'section'; id: string; title: string; subtitle: string }
  | { type: 'camp'; camp: CampWithMembership }

const REJECTION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

function getAccessLabel(camp: Doc<'camps'>) {
  if (camp.access === 'invite') return 'Invite only'
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
  const isRejected = camp.membership?.status === 'rejected'
  const isFrozen = camp.frozen === true || camp.status === 'frozen'

  const rejectedAt = camp.membership?.rejectedAt
  const cooldownExpired =
    isRejected && rejectedAt != null && Date.now() - rejectedAt >= REJECTION_COOLDOWN_MS
  const isInCooldown = isRejected && !cooldownExpired
  const cooldownEndDate = rejectedAt != null ? new Date(rejectedAt + REJECTION_COOLDOWN_MS) : null
  const canJoinFromList = !isActiveMember && !isPending && !isInCooldown && camp.access !== 'invite'

  return (
    <Pressable onPress={onOpen}>
      <YStack paddingHorizontal={16} paddingVertical={14} gap={12} overflow="hidden">
        {isPending ? <CampCardStatusBanner variant="pending" /> : null}
        {isInCooldown ? <CampCardStatusBanner variant="rejected" /> : null}
        <XStack alignItems="flex-start" gap={12}>
          <YStack
            width={54}
            height={54}
            borderRadius={16}
            backgroundColor={camp.color ?? bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
          >
            {camp.access === 'invite' ? (
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

              {isFrozen ? (
                <YStack
                  borderRadius={999}
                  paddingHorizontal={10}
                  paddingVertical={5}
                  backgroundColor={`${bondfireColors.warning}20`}
                  borderWidth={1}
                  borderColor={bondfireColors.warning}
                >
                  <Text fontSize={11} color={bondfireColors.warning} fontWeight="900">
                    🔒 Frozen
                  </Text>
                </YStack>
              ) : isActiveMember ? (
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
              {isInCooldown ? (
                <Text fontSize={12} color={bondfireColors.error} fontWeight="900">
                  {cooldownEndDate
                    ? `Denied — retry ${cooldownEndDate.toLocaleDateString()}`
                    : 'Request denied'}
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

function PersonalCampCard({
  personalCamp,
  canCreatePrivateCamp,
  onOpen,
  onUpgrade,
}: {
  personalCamp: Doc<'personalCamps'> | null
  canCreatePrivateCamp: boolean
  onOpen: () => void
  onUpgrade: () => void
}) {
  if (personalCamp) {
    return (
      <Pressable onPress={onOpen}>
        <YStack
          padding={14}
          borderRadius={14}
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.bondfireCopper}
          gap={8}
        >
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <XStack alignItems="center" gap={10} flex={1}>
              <YStack
                width={36}
                height={36}
                borderRadius={18}
                backgroundColor={`${bondfireColors.bondfireCopper}20`}
                alignItems="center"
                justifyContent="center"
              >
                <Flame size={18} color={bondfireColors.bondfireCopper} />
              </YStack>
              <YStack gap={2} flex={1}>
                <Text fontSize={15} fontWeight="900" numberOfLines={1}>
                  {personalCamp.name}
                </Text>
                <Text fontSize={12} color={bondfireColors.ash}>
                  Your Personal Camp
                </Text>
              </YStack>
            </XStack>
            {personalCamp.status === 'frozen' ? (
              <YStack
                borderRadius={999}
                paddingHorizontal={8}
                paddingVertical={4}
                backgroundColor={`${bondfireColors.warning}20`}
                borderWidth={1}
                borderColor={bondfireColors.warning}
              >
                <Text fontSize={10} color={bondfireColors.warning} fontWeight="900">
                  Frozen
                </Text>
              </YStack>
            ) : null}
          </XStack>
        </YStack>
      </Pressable>
    )
  }

  if (canCreatePrivateCamp) {
    return (
      <Pressable onPress={onOpen}>
        <YStack
          padding={14}
          borderRadius={14}
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.bondfireCopper}
          gap={8}
        >
          <XStack alignItems="center" gap={10}>
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={`${bondfireColors.bondfireCopper}20`}
              alignItems="center"
              justifyContent="center"
            >
              <Flame size={18} color={bondfireColors.bondfireCopper} />
            </YStack>
            <YStack gap={2} flex={1}>
              <Text fontSize={15} fontWeight="900">
                Personal Camp
              </Text>
              <Text fontSize={12} color={bondfireColors.ash}>
                Your private fires will appear here once your camp is ready.
              </Text>
            </YStack>
          </XStack>
        </YStack>
      </Pressable>
    )
  }

  return (
    <Pressable onPress={onUpgrade}>
      <YStack
        padding={14}
        borderRadius={14}
        backgroundColor={bondfireColors.gunmetal}
        borderWidth={1}
        borderColor={bondfireColors.iron}
        gap={8}
      >
        <XStack alignItems="center" gap={10}>
          <YStack
            width={36}
            height={36}
            borderRadius={18}
            backgroundColor={`${bondfireColors.ash}20`}
            alignItems="center"
            justifyContent="center"
          >
            <Lock size={18} color={bondfireColors.ash} />
          </YStack>
          <YStack gap={2} flex={1}>
            <Text fontSize={15} fontWeight="900" color={bondfireColors.ash}>
              Personal Camp
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              Upgrade to Plus to start your own fire.
            </Text>
          </YStack>
        </XStack>
      </YStack>
    </Pressable>
  )
}

export default function CampsScreen() {
  const router = useRouter()
  const camps = useQuery(api.camps.list, {})
  const myCamps = useQuery(api.camps.listMine, {})
  const personalCamp = useQuery(api.personalCamps.getMyPersonalCamp, {})
  const subscription = useQuery(api.subscriptions.current, {})
  const slotBalance = useQuery(
    api.campSlots.getSlotBalance,
    subscription?.tier === 'pro' ? {} : 'skip',
  )
  const joinCamp = useMutation(api.camps.join)
  const requestJoinCamp = useMutation(api.camps.requestJoin)
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
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const canCreatePrivateCamp =
    subscription?.tier === 'plus' ||
    subscription?.tier === 'premium' ||
    subscription?.tier === 'pro'
  const isPro = subscription?.tier === 'pro'
  const shouldShowPersonalCampCard = subscription !== undefined && personalCamp !== undefined

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

  const archivedCamps = useMemo<CampWithMembership[]>(() => {
    if (!myCamps) return []
    return myCamps.filter((camp: CampWithMembership) => camp.status === 'archived')
  }, [myCamps])

  const listItems = useMemo<CampListItem[]>(() => {
    if (!filtered) return []

    const privateCamps = filtered.filter((camp) => camp.access === 'invite')
    const publicCamps = filtered.filter((camp) => camp.access !== 'invite')
    const items: CampListItem[] = []

    if (privateCamps.length > 0) {
      items.push({
        type: 'section',
        id: 'private',
        title: 'Invite-Only Camps',
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

  const handleOpenPersonalCamp = useCallback(() => {
    router.push('/(main)/personal-camp' as RelativePathString)
  }, [router])

  const handleUpgrade = useCallback(() => {
    subscriptionActions.showPaywall()
  }, [])

  const handleJoin = useCallback(
    async (camp: CampWithMembership) => {
      try {
        const result =
          camp.access === 'approval'
            ? await requestJoinCamp({ campId: camp._id })
            : await joinCamp({ campId: camp._id })
        if (result.status === 'pending') {
          Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
        }
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Camp Unavailable', message)
      }
    },
    [joinCamp, requestJoinCamp],
  )

  const handleCreatePrivateCamp = useCallback(async () => {
    if (!canCreatePrivateCamp) {
      Alert.alert('Membership Required', 'Private camps require Plus, Premium, or Pro.')
      return
    }

    const name = privateCampName.trim()
    if (name.length < 3) {
      Alert.alert('Name Required', 'Give your private camp a name first.')
      return
    }

    if (subscription?.tier === 'pro' && slotBalance !== undefined && slotBalance.balance < 1) {
      Alert.alert('Camp Slots Required', 'Buy a slot pack to create more private camps.')
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
      const message = parseError(error).message
      Alert.alert('Private Camp Unavailable', message)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    canCreatePrivateCamp,
    createPrivateCamp,
    privateCampName,
    privateCampPurpose,
    router,
    slotBalance,
    subscription?.tier,
  ])

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
      const message = parseError(error).message
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

            {shouldShowPersonalCampCard ? (
              <PersonalCampCard
                personalCamp={personalCamp}
                canCreatePrivateCamp={canCreatePrivateCamp}
                onOpen={handleOpenPersonalCamp}
                onUpgrade={handleUpgrade}
              />
            ) : null}

            <XStack gap={10}>
              {isPro ? (
                <Button
                  variant="secondary"
                  size="$sm"
                  flex={1}
                  onPress={() => setIsCreatePrivateOpen(true)}
                >
                  <Sparkles size={15} color={bondfireColors.whiteSmoke} />
                  <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                    Create Camp
                  </Text>
                </Button>
              ) : null}
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
        ListFooterComponent={
          query.trim().length > 0 || archivedCamps.length === 0 ? null : (
            <YStack paddingBottom={32}>
              {/* Header row — always visible */}
              <Pressable onPress={() => setArchivedExpanded(!archivedExpanded)}>
                <XStack
                  paddingHorizontal={16}
                  paddingVertical={14}
                  alignItems="center"
                  gap={8}
                  borderTopWidth={1}
                  borderTopColor={bondfireColors.iron}
                  marginTop={8}
                >
                  <YStack flex={1} gap={2}>
                    <Text fontSize={13} color={bondfireColors.error} fontWeight="900">
                      Archived ({archivedCamps.length})
                    </Text>
                    <Text fontSize={12} color={bondfireColors.ash}>
                      Read-only. Content will be deleted after 30 days.
                    </Text>
                  </YStack>
                  {archivedExpanded ? (
                    <ChevronUp size={18} color={bondfireColors.ash} />
                  ) : (
                    <ChevronDown size={18} color={bondfireColors.ash} />
                  )}
                </XStack>
              </Pressable>

              {/* Collapsed camp list */}
              {archivedExpanded
                ? archivedCamps.map((camp, index) => (
                    <YStack key={camp._id}>
                      <Pressable
                        onPress={() =>
                          router.push(`/(main)/camp/${camp._id}` as RelativePathString)
                        }
                      >
                        <XStack
                          paddingHorizontal={16}
                          paddingVertical={12}
                          alignItems="center"
                          gap={12}
                          opacity={0.7}
                        >
                          <YStack
                            width={40}
                            height={40}
                            borderRadius={12}
                            backgroundColor={camp.color ?? bondfireColors.gunmetal}
                            alignItems="center"
                            justifyContent="center"
                          >
                            <Lock size={18} color={bondfireColors.whiteSmoke} />
                          </YStack>
                          <YStack flex={1} gap={2}>
                            <Text fontSize={14} fontWeight="900" numberOfLines={1}>
                              {camp.name}
                            </Text>
                            <Text fontSize={12} color={bondfireColors.ash}>
                              Archived {camp.archivedAt ? getTimeAgo(camp.archivedAt) : 'recently'}{' '}
                              · {camp.activeMemberCount ?? 0}{' '}
                              {camp.activeMemberCount === 1 ? 'member' : 'members'}
                            </Text>
                          </YStack>
                        </XStack>
                      </Pressable>
                      {index < archivedCamps.length - 1 ? (
                        <Separator
                          borderColor={bondfireColors.iron}
                          opacity={0.4}
                          marginHorizontal={16}
                        />
                      ) : null}
                    </YStack>
                  ))
                : null}
            </YStack>
          )
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
              Create Camp
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
          {subscription?.tier === 'pro' && slotBalance !== undefined ? (
            <YStack
              borderRadius={10}
              backgroundColor={bondfireColors.gunmetal}
              borderWidth={1}
              borderColor={bondfireColors.iron}
              padding={10}
              gap={4}
            >
              <Text fontSize={11} color={bondfireColors.ash} fontWeight="900">
                CAMP SLOTS
              </Text>
              <Text
                fontSize={18}
                fontWeight="900"
                color={slotBalance.balance > 0 ? bondfireColors.success : bondfireColors.error}
              >
                {slotBalance.balance} slot{slotBalance.balance !== 1 ? 's' : ''} remaining
              </Text>
              {slotBalance.balance < 1 ? (
                <Text fontSize={12} color={bondfireColors.ash}>
                  Buy a slot pack to create more camps.
                </Text>
              ) : null}
            </YStack>
          ) : null}
          <Button
            variant="primary"
            size="$lg"
            disabled={
              isSubmitting ||
              (subscription?.tier === 'pro' && slotBalance !== undefined && slotBalance.balance < 1)
            }
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
