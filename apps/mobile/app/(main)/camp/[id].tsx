import {
  appActions,
  getBondfireVideoIndex,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { ArrowLeft, Bell, BellOff, Flame, Lock, MessageCircle } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { Alert, FlatList, Pressable, StatusBar } from 'react-native'
import { Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'

type CampWithMembership = Doc<'camps'> & {
  membership: Doc<'campMembers'> | null
}

type BondfireData = Doc<'bondfires'> & {
  isLive?: boolean
  livePlaybackId?: string
}

function getAccessLabel(camp: Doc<'camps'>) {
  if (camp.visibility === 'private') return 'Invite only'
  if (camp.access === 'approval') return 'Approval required'
  return 'Open camp'
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return [Math.floor(seconds / 60), 'm ago'].join('')
  if (seconds < 86400) return [Math.floor(seconds / 3600), 'h ago'].join('')
  if (seconds < 604800) return [Math.floor(seconds / 86400), 'd ago'].join('')
  return [Math.floor(seconds / 604800), 'w ago'].join('')
}

function RulePill({ label }: { label: string }) {
  return (
    <YStack
      paddingHorizontal={10}
      paddingVertical={6}
      borderRadius={999}
      backgroundColor={bondfireColors.gunmetal}
      borderWidth={1}
      borderColor={bondfireColors.iron}
    >
      <Text fontSize={12} color={bondfireColors.whiteSmoke} fontWeight="800">
        {label}
      </Text>
    </YStack>
  )
}

function getFirstVisitBanner(camp: Doc<'camps'>) {
  const slug = camp.slug.toLowerCase()
  if (slug.startsWith('the-pursuit-')) {
    return {
      title: 'First time in The Pursuit',
      body: 'This camp is for dating toward long-term partnership. Speak with maturity, avoid objectifying language, and keep the other person dignified.',
    }
  }

  if (slug.startsWith('the-tempering-')) {
    return {
      title: 'First time in The Tempering',
      body: 'This camp is for discipline, recovery, and resilience. Share plainly without graphic detail that could pull someone else backward.',
    }
  }

  return null
}

function CampHeader({
  camp,
  onBack,
  onJoin,
  onMute,
  onSpark,
}: {
  camp: CampWithMembership
  onBack: () => void
  onJoin: () => void
  onMute: () => void
  onSpark: () => void
}) {
  const isActiveMember = camp.membership?.status === 'active'
  const isPending = camp.membership?.status === 'pending'
  const muted = camp.membership?.muted === true
  const canJoin = !isActiveMember && !isPending && camp.visibility === 'public'
  const rules = camp.rules
  const firstVisitBanner = getFirstVisitBanner(camp)

  return (
    <YStack paddingTop={58} paddingHorizontal={16} paddingBottom={18} gap={18}>
      <XStack alignItems="center" justifyContent="space-between">
        <Pressable onPress={onBack}>
          <YStack
            width={42}
            height={42}
            borderRadius={21}
            alignItems="center"
            justifyContent="center"
            backgroundColor={bondfireColors.gunmetal}
            borderWidth={1}
            borderColor={bondfireColors.iron}
          >
            <ArrowLeft size={22} color={bondfireColors.whiteSmoke} />
          </YStack>
        </Pressable>

        {isActiveMember ? (
          <Pressable onPress={onMute}>
            <YStack
              width={42}
              height={42}
              borderRadius={21}
              alignItems="center"
              justifyContent="center"
              backgroundColor={bondfireColors.gunmetal}
              borderWidth={1}
              borderColor={muted ? bondfireColors.warning : bondfireColors.iron}
            >
              {muted ? (
                <BellOff size={20} color={bondfireColors.warning} />
              ) : (
                <Bell size={20} color={bondfireColors.whiteSmoke} />
              )}
            </YStack>
          </Pressable>
        ) : null}
      </XStack>

      <XStack alignItems="center" gap={14}>
        <YStack
          width={72}
          height={72}
          borderRadius={20}
          backgroundColor={camp.color ?? bondfireColors.gunmetal}
          alignItems="center"
          justifyContent="center"
        >
          {camp.visibility === 'private' ? (
            <Lock size={32} color={bondfireColors.whiteSmoke} />
          ) : (
            <Flame size={36} color={bondfireColors.whiteSmoke} />
          )}
        </YStack>

        <YStack flex={1} gap={4}>
          <Text fontSize={26} fontWeight="900" numberOfLines={2}>
            {camp.name}
          </Text>
          <Text fontSize={14} color={bondfireColors.ash}>
            {camp.theme ?? getAccessLabel(camp)}
          </Text>
        </YStack>
      </XStack>

      <Text fontSize={15} color={bondfireColors.whiteSmoke} lineHeight={22}>
        {camp.purpose}
      </Text>

      {firstVisitBanner ? (
        <YStack
          padding={14}
          borderRadius={16}
          backgroundColor={bondfireColors.charcoal}
          borderWidth={1}
          borderColor={camp.color ?? bondfireColors.iron}
          gap={6}
        >
          <Text fontSize={12} color={bondfireColors.moltenGold} fontWeight="900">
            {firstVisitBanner.title}
          </Text>
          <Text fontSize={14} color={bondfireColors.whiteSmoke} lineHeight={20}>
            {firstVisitBanner.body}
          </Text>
        </YStack>
      ) : null}

      <XStack flexWrap="wrap" gap={8}>
        <RulePill label={getAccessLabel(camp)} />
        <RulePill label={[camp.activeMemberCount ?? 0, 'members'].join(' ')} />
        {rules.gender ? (
          <RulePill label={rules.gender === 'any' ? 'All genders' : rules.gender} />
        ) : null}
        {rules.maxDurationMs ? (
          <RulePill label={['Max', Math.round(rules.maxDurationMs / 60000), 'min'].join(' ')} />
        ) : null}
        {rules.requiresTradeTags ? <RulePill label="Need/offer tags" /> : null}
      </XStack>

      {camp.defaultPrompt ? (
        <YStack
          padding={14}
          borderRadius={16}
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.iron}
          gap={6}
        >
          <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
            Prompt
          </Text>
          <Text fontSize={15} color={bondfireColors.whiteSmoke} lineHeight={21}>
            {camp.defaultPrompt}
          </Text>
        </YStack>
      ) : null}

      {isActiveMember ? (
        <Button variant="primary" size="$lg" onPress={onSpark}>
          <Flame size={20} color={bondfireColors.whiteSmoke} />
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            Spark Here
          </Text>
        </Button>
      ) : null}

      {canJoin ? (
        <Button variant="primary" size="$lg" onPress={onJoin}>
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            {camp.access === 'approval' ? 'Request to Join' : 'Join Camp'}
          </Text>
        </Button>
      ) : null}

      {isPending ? (
        <YStack padding={12} borderRadius={14} backgroundColor={bondfireColors.gunmetal}>
          <Text color={bondfireColors.warning} fontWeight="900" textAlign="center">
            Membership pending approval
          </Text>
        </YStack>
      ) : null}
    </YStack>
  )
}

function BondfireRow({ bondfire, onOpen }: { bondfire: BondfireData; onOpen: () => void }) {
  const responses = Math.max(0, bondfire.videoCount - 1)

  return (
    <Pressable onPress={onOpen}>
      <XStack paddingHorizontal={16} paddingVertical={13} gap={12} alignItems="center">
        <YStack
          width={50}
          height={50}
          borderRadius={15}
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.iron}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={24} color={bondfireColors.bondfireCopper} />
        </YStack>

        <YStack flex={1} gap={4}>
          <Text fontSize={16} fontWeight="900" numberOfLines={1}>
            {bondfire.creatorName ?? 'Anonymous'}
          </Text>
          <Text fontSize={12} color={bondfireColors.ash}>
            {bondfire.videoStatus === 'live' ? 'Live now' : getTimeAgo(bondfire.createdAt)}
          </Text>
        </YStack>

        <XStack alignItems="center" gap={6}>
          <MessageCircle size={15} color={bondfireColors.ash} />
          <Text fontSize={13} color={bondfireColors.ash}>
            {responses}
          </Text>
        </XStack>
      </XStack>
    </Pressable>
  )
}

export default function CampDetailScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const campId = id as Id<'camps'> | undefined
  const camp = useQuery(api.camps.get, campId ? { campId } : 'skip')
  const bondfires = useQuery(api.bondfires.listByCamp, campId ? { campId, limit: 50 } : 'skip')
  const joinCamp = useMutation(api.camps.join)
  const muteCamp = useMutation(api.camps.muteCamp)

  const handleJoin = useCallback(async () => {
    if (!campId) return
    try {
      const result = await joinCamp({ campId })
      if (result.status === 'pending') {
        Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to join camp'
      Alert.alert('Camp Unavailable', message)
    }
  }, [campId, joinCamp])

  const handleMute = useCallback(async () => {
    if (!camp || !campId || !camp.membership) return
    await muteCamp({ campId, muted: !camp.membership.muted })
  }, [camp, campId, muteCamp])

  const handleSpark = useCallback(() => {
    if (!campId) return
    router.push({ pathname: '/(main)/(tabs)/create', params: { campId } })
  }, [campId, router])

  const handleOpenBondfire = useCallback(
    (bondfireId: string) => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      appActions.setVideoMuted(false)
      router.push({ pathname: '/(main)/bondfire/[id]', params: { id: bondfireId } })
    },
    [router],
  )

  if (camp === undefined || bondfires === undefined) {
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
          Loading camp...
        </Text>
      </YStack>
    )
  }

  if (!camp) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        padding={24}
        justifyContent="center"
        gap={16}
      >
        <Text fontSize={22} fontWeight="900" textAlign="center">
          Camp unavailable
        </Text>
        <Button variant="primary" size="$lg" onPress={() => router.back()}>
          <Text color={bondfireColors.whiteSmoke} fontWeight="900">
            Go Back
          </Text>
        </Button>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <FlatList
        data={bondfires ?? []}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => (
          <BondfireRow bondfire={item} onOpen={() => handleOpenBondfire(item._id)} />
        )}
        ItemSeparatorComponent={() => (
          <Separator borderColor={bondfireColors.iron} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <CampHeader
            camp={camp}
            onBack={() => router.back()}
            onJoin={handleJoin}
            onMute={handleMute}
            onSpark={handleSpark}
          />
        }
        ListEmptyComponent={
          <YStack paddingVertical={64} paddingHorizontal={32} alignItems="center" gap={12}>
            <Flame size={54} color={bondfireColors.bondfireCopper} />
            <Text fontSize={19} fontWeight="900" textAlign="center">
              No Bondfires yet
            </Text>
            <Text fontSize={14} color={bondfireColors.ash} textAlign="center" lineHeight={21}>
              This camp is ready. The first spark will set the tone.
            </Text>
          </YStack>
        }
        contentContainerStyle={{ paddingBottom: 42 }}
      />
    </YStack>
  )
}
