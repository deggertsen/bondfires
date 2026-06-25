import { freeUpgradeActions, parseError, useAppThemeColors } from '@bondfires/app'
import { Button, CampCardStatusBanner, Input, Spinner, Text } from '@bondfires/ui'
import {
  ChevronDown,
  ChevronUp,
  Flame,
  Info,
  Lock,
  Search,
  Sparkles,
  Users,
} from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Image, Separator, Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'
import { routes } from '../../../lib/routes'

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
  const accentColor = camp.accentColor
  const coverImageUrl = camp.coverImageUrl

  return (
    <Pressable onPress={onOpen}>
      <YStack
        paddingHorizontal={16}
        paddingVertical={14}
        gap={12}
        overflow="hidden"
        borderLeftWidth={accentColor ? 3 : 0}
        borderLeftColor={accentColor ?? 'transparent'}
      >
        {isPending ? <CampCardStatusBanner variant="pending" /> : null}
        {isInCooldown ? <CampCardStatusBanner variant="rejected" /> : null}
        <XStack alignItems="flex-start" gap={12}>
          <YStack
            width={54}
            height={54}
            borderRadius={16}
            backgroundColor={camp.color ?? '$backgroundHover'}
            alignItems="center"
            justifyContent="center"
            overflow="hidden"
          >
            {coverImageUrl ? (
              <Image source={{ uri: coverImageUrl }} width={54} height={54} resizeMode="cover" />
            ) : camp.access === 'invite' ? (
              <Lock size={25} color={'$color'} />
            ) : (
              <Flame size={28} color={'$color'} />
            )}
          </YStack>

          <YStack flex={1} gap={7}>
            <XStack alignItems="center" justifyContent="space-between" gap={10}>
              <YStack flex={1} gap={2}>
                <Text fontSize={17} fontWeight="900" numberOfLines={1}>
                  {camp.name}
                </Text>
                <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                  {camp.theme ?? getAccessLabel(camp)}
                </Text>
              </YStack>

              {isFrozen ? (
                <YStack
                  borderRadius={999}
                  paddingHorizontal={10}
                  paddingVertical={5}
                  backgroundColor={'rgba(245, 158, 11, 0.13)'}
                  borderWidth={1}
                  borderColor={'$warning'}
                >
                  <Text fontSize={11} color={'$warning'} fontWeight="900">
                    🔒 Frozen
                  </Text>
                </YStack>
              ) : isActiveMember ? (
                <YStack
                  borderRadius={999}
                  paddingHorizontal={10}
                  paddingVertical={5}
                  backgroundColor={'$backgroundPress'}
                  borderWidth={1}
                  borderColor={'$borderColor'}
                >
                  <Text fontSize={11} color={'$color'} fontWeight="900">
                    Joined
                  </Text>
                </YStack>
              ) : null}
            </XStack>

            <Text fontSize={14} color={'$color'} lineHeight={20} numberOfLines={2}>
              {camp.purpose}
            </Text>

            <XStack alignItems="center" justifyContent="space-between" gap={10}>
              <XStack alignItems="center" gap={12} flex={1}>
                <XStack alignItems="center" gap={5}>
                  <Users size={14} color={'$placeholderColor'} />
                  <Text fontSize={12} color={'$placeholderColor'}>
                    {getMemberLabel(camp)}
                  </Text>
                </XStack>
                <Text fontSize={12} color={'$placeholderColor'}>
                  {getAccessLabel(camp)}
                </Text>
              </XStack>

              {canJoinFromList ? (
                <Button variant="outline" size="$sm" onPress={onJoin}>
                  <Text color={'$color'} fontWeight="900">
                    {camp.access === 'approval' ? 'Request' : 'Join'}
                  </Text>
                </Button>
              ) : null}
              {isPending ? (
                <Text fontSize={12} color={'$warning'} fontWeight="900">
                  Pending
                </Text>
              ) : null}
              {isInCooldown ? (
                <Text fontSize={12} color={'$error'} fontWeight="900">
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
      <Flame size={58} color={'$primary'} />
      <Text fontSize={20} fontWeight="900" textAlign="center">
        {hasQuery ? 'No matching camps' : 'No camps yet'}
      </Text>
      <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={21}>
        {hasQuery
          ? 'Try a different search.'
          : 'Seed the launch camps from Convex before opening this surface.'}
      </Text>
      {hasQuery ? (
        <Button variant="outline" size="$md" onPress={onReset}>
          <Text color={'$color'} fontWeight="900">
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
      <Text fontSize={13} color={'$primary'} fontWeight="900">
        {title}
      </Text>
      <Text fontSize={12} color={'$placeholderColor'}>
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
  onExplainer,
}: {
  personalCamp: Doc<'personalCamps'> | null
  canCreatePrivateCamp: boolean
  onOpen: () => void
  onUpgrade: () => void
  onExplainer: () => void
}) {
  if (personalCamp) {
    return (
      <Pressable onPress={onOpen}>
        <YStack
          padding={14}
          borderRadius={14}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$primary'}
          gap={8}
        >
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <XStack alignItems="center" gap={10} flex={1}>
              <YStack
                width={36}
                height={36}
                borderRadius={18}
                backgroundColor={'rgba(217, 119, 54, 0.13)'}
                alignItems="center"
                justifyContent="center"
              >
                <Flame size={18} color={'$primary'} />
              </YStack>
              <YStack gap={2} flex={1}>
                <Text fontSize={15} fontWeight="900" numberOfLines={1}>
                  {personalCamp.name}
                </Text>
                <Text fontSize={12} color={'$placeholderColor'}>
                  Your Hearth
                </Text>
              </YStack>
            </XStack>
            {personalCamp.status === 'frozen' ? (
              <YStack
                borderRadius={999}
                paddingHorizontal={8}
                paddingVertical={4}
                backgroundColor={'rgba(245, 158, 11, 0.13)'}
                borderWidth={1}
                borderColor={'$warning'}
              >
                <Text fontSize={10} color={'$warning'} fontWeight="900">
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
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$primary'}
          gap={8}
        >
          <XStack alignItems="center" gap={10}>
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'rgba(217, 119, 54, 0.13)'}
              alignItems="center"
              justifyContent="center"
            >
              <Flame size={18} color={'$primary'} />
            </YStack>
            <YStack gap={2} flex={1}>
              <Text fontSize={15} fontWeight="900">
                Hearth
              </Text>
              <Text fontSize={12} color={'$placeholderColor'}>
                Your private fires will appear here once your hearth is ready.
              </Text>
            </YStack>
          </XStack>
        </YStack>
      </Pressable>
    )
  }

  // Free-tier Hearth card (M3): same outer card style as above, but richer
  // content — a real value prop for what Hearth is, a discoverability "i" that
  // opens the free-capabilities explainer (W2), and an inline upgrade CTA. The
  // whole card stays tappable (opens the paywall). Outer padding/radius/colors
  // are unchanged so the card frame matches the paid-tier states.
  return (
    <Pressable onPress={onUpgrade}>
      <YStack
        padding={14}
        borderRadius={14}
        backgroundColor={'$backgroundHover'}
        borderWidth={1}
        borderColor={'$borderColor'}
        gap={8}
      >
        <XStack alignItems="center" gap={10}>
          <YStack
            width={36}
            height={36}
            borderRadius={18}
            backgroundColor={'rgba(156, 163, 175, 0.13)'}
            alignItems="center"
            justifyContent="center"
          >
            <Lock size={18} color={'$placeholderColor'} />
          </YStack>
          <YStack gap={3} flex={1}>
            <Text fontSize={15} fontWeight="900">
              Hearth
            </Text>
            <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
              A private camp for your inner circle — invite-only, with 7-day invite codes and fires
              that stay between the people you trust.
            </Text>
          </YStack>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="What can I do for free?"
            hitSlop={10}
            onPress={(event) => {
              event.stopPropagation()
              onExplainer()
            }}
          >
            <Info size={18} color={'$placeholderColor'} />
          </Pressable>
        </XStack>
        <XStack alignItems="center" gap={6} paddingLeft={46}>
          <Flame size={13} color={'$primary'} />
          <Text fontSize={13} color={'$primary'} fontWeight="900">
            Upgrade to Plus →
          </Text>
        </XStack>
      </YStack>
    </Pressable>
  )
}

export default function CampsScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const camps = useQuery(api.camps.list, {})
  const myCamps = useQuery(api.camps.listMine, {})
  const personalCamp = useQuery(api.personalCamps.getMyPersonalCamp, {})
  const ensurePersonalCamp = useMutation(api.personalCamps.ensureMyPersonalCamp)
  const personalCampEnsured = useRef(false)
  const subscription = useQuery(api.subscriptions.current, {})
  const kindlingBalance = useQuery(
    api.campKindling.getKindlingBalance,
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

  // Eagerly create hearth for paid-tier users who don't have one yet
  // (e.g. admins, forced-tier users, manual tier assignments)
  useEffect(() => {
    if (
      !personalCampEnsured.current &&
      canCreatePrivateCamp &&
      personalCamp === null &&
      ensurePersonalCamp
    ) {
      personalCampEnsured.current = true
      ensurePersonalCamp({}).catch(() => {
        personalCampEnsured.current = false
      })
    }
  }, [canCreatePrivateCamp, personalCamp, ensurePersonalCamp])

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
    router.push(routes.personalCamp)
  }, [router])

  const handleUpgrade = useCallback(() => {
    freeUpgradeActions.pressPaywallCta('camps_hearth_card')
  }, [])

  const handleHearthExplainer = useCallback(() => {
    freeUpgradeActions.openExplainer('camps_hearth_card')
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

    if (
      subscription?.tier === 'pro' &&
      kindlingBalance !== undefined &&
      kindlingBalance.balance < 1
    ) {
      Alert.alert('Camp Kindling Required', 'Buy a kindling pack to create more private camps.')
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
      router.push(routes.camp(campId))
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
    kindlingBalance,
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
      router.push(routes.camp(result.campId))
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Invite Unavailable', message)
    } finally {
      setIsSubmitting(false)
    }
  }, [inviteCode, redeemInvite, router])

  if (camps === undefined) {
    return (
      <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
        <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
        <Spinner size="large" color={'$primary'} />
        <Text marginTop={18} color={'$placeholderColor'}>
          Loading camps...
        </Text>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />

      <FlatList
        data={listItems}
        keyExtractor={(item) => (item.type === 'section' ? item.id : item.camp._id)}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        renderItem={({ item }) =>
          item.type === 'section' ? (
            <SectionHeader title={item.title} subtitle={item.subtitle} />
          ) : (
            <CampCard
              camp={item.camp}
              onOpen={() => router.push(routes.camp(item.camp._id))}
              onJoin={() => handleJoin(item.camp)}
            />
          )
        }
        ItemSeparatorComponent={() => (
          <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={68} paddingBottom={14} paddingHorizontal={16} gap={14}>
            <YStack gap={4}>
              <Text fontSize={28} fontWeight="900">
                Camps
              </Text>
              <Text fontSize={14} color={'$placeholderColor'}>
                Browse the spaces where Bondfires gather.
              </Text>
            </YStack>

            {shouldShowPersonalCampCard ? (
              <PersonalCampCard
                personalCamp={personalCamp}
                canCreatePrivateCamp={canCreatePrivateCamp}
                onOpen={handleOpenPersonalCamp}
                onUpgrade={handleUpgrade}
                onExplainer={handleHearthExplainer}
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
                  <Sparkles size={15} color={'$color'} />
                  <Text color={'$color'} fontWeight="900">
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
                <Text color={'$color'} fontWeight="900">
                  Redeem Invite
                </Text>
              </Button>
            </XStack>

            <XStack
              alignItems="center"
              gap={10}
              backgroundColor={'$backgroundHover'}
              borderRadius={14}
              borderWidth={1}
              borderColor={'$borderColor'}
              paddingHorizontal={12}
              paddingVertical={10}
            >
              <Search size={18} color={'$placeholderColor'} />
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
              <Text fontSize={12} color={'$placeholderColor'} fontWeight="900">
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
                  borderTopColor={'$borderColor'}
                  marginTop={8}
                >
                  <YStack flex={1} gap={2}>
                    <Text fontSize={13} color={'$error'} fontWeight="900">
                      Archived ({archivedCamps.length})
                    </Text>
                    <Text fontSize={12} color={'$placeholderColor'}>
                      Read-only. Content will be deleted after 30 days.
                    </Text>
                  </YStack>
                  {archivedExpanded ? (
                    <ChevronUp size={18} color={'$placeholderColor'} />
                  ) : (
                    <ChevronDown size={18} color={'$placeholderColor'} />
                  )}
                </XStack>
              </Pressable>

              {/* Collapsed camp list */}
              {archivedExpanded
                ? archivedCamps.map((camp, index) => (
                    <YStack key={camp._id}>
                      <Pressable onPress={() => router.push(routes.camp(camp._id))}>
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
                            backgroundColor={camp.color ?? '$backgroundHover'}
                            alignItems="center"
                            justifyContent="center"
                          >
                            <Lock size={18} color={'$color'} />
                          </YStack>
                          <YStack flex={1} gap={2}>
                            <Text fontSize={14} fontWeight="900" numberOfLines={1}>
                              {camp.name}
                            </Text>
                            <Text fontSize={12} color={'$placeholderColor'}>
                              Archived {camp.archivedAt ? getTimeAgo(camp.archivedAt) : 'recently'}{' '}
                              · {camp.activeMemberCount ?? 0}{' '}
                              {camp.activeMemberCount === 1 ? 'member' : 'members'}
                            </Text>
                          </YStack>
                        </XStack>
                      </Pressable>
                      {index < archivedCamps.length - 1 ? (
                        <Separator
                          borderColor={'$borderColor'}
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
        moveOnKeyboardChange
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
        <Sheet.Frame padding={20} backgroundColor={'$backgroundPress'} gap={16}>
          <Sheet.Handle backgroundColor={'$borderColor'} />
          <YStack gap={6}>
            <Text fontSize={22} fontWeight="900">
              Create Camp
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
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
          {subscription?.tier === 'pro' && kindlingBalance !== undefined ? (
            <YStack
              borderRadius={10}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$borderColor'}
              padding={10}
              gap={4}
            >
              <Text fontSize={11} color={'$placeholderColor'} fontWeight="900">
                CAMP KINDLING
              </Text>
              <Text
                fontSize={18}
                fontWeight="900"
                color={kindlingBalance.balance > 0 ? '$success' : '$error'}
              >
                {kindlingBalance.balance} kindling remaining
              </Text>
              {kindlingBalance.balance < 1 ? (
                <Text fontSize={12} color={'$placeholderColor'}>
                  Buy a kindling pack to create more camps.
                </Text>
              ) : null}
            </YStack>
          ) : null}
          <Button
            variant="primary"
            size="$lg"
            disabled={
              isSubmitting ||
              (subscription?.tier === 'pro' &&
                kindlingBalance !== undefined &&
                kindlingBalance.balance < 1)
            }
            onPress={handleCreatePrivateCamp}
          >
            {isSubmitting ? (
              <Spinner color={'$color'} />
            ) : (
              <Text color={'$color'} fontWeight="900">
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
        moveOnKeyboardChange
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
        <Sheet.Frame padding={20} backgroundColor={'$backgroundPress'} gap={16}>
          <Sheet.Handle backgroundColor={'$borderColor'} />
          <YStack gap={6}>
            <Text fontSize={22} fontWeight="900">
              Redeem Invite
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
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
              <Spinner color={'$color'} />
            ) : (
              <Text color={'$color'} fontWeight="900">
                Join Camp
              </Text>
            )}
          </Button>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  )
}
