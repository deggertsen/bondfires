import {
  appActions,
  freeUpgradeActions,
  getBondfireVideoIndex,
  parseError,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  useAppThemeColors,
  useSubscription,
} from '@bondfires/app'
import { Button, Spinner, type SwipeAction, SwipeableRow, Text } from '@bondfires/ui'
import {
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Flame,
  Lock,
  MessageCircle,
  Shield,
  UserX,
} from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, FlatList, Modal, Pressable, StatusBar, TextInput } from 'react-native'
import { Separator, Image as TamaguiImage, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { EditTitleSheet, useEditTitleSheet } from '../../../components/EditTitleSheet'
import { InviteSheet } from '../../../components/InviteSheet'
import { getBondfireRightSwipeActions } from '../../../lib/bondfireSwipeActions'
import { goBackOrReplace } from '../../../lib/navigation'
import { routes } from '../../../lib/routes'
import { OwnerCampSections } from './OwnerCampSections'

type CampWithMembership = Doc<'camps'> & {
  membership: Doc<'campMembers'> | null
  frozen?: boolean
}

type PendingRequest = {
  membershipId: string
  userId: string
  requestedAt: number
  role: string
  userName: string
  displayName?: string
  photoUrl?: string
}

type CampMember = {
  membershipId: string
  userId: string
  role: 'owner' | 'moderator' | 'member'
  status: string
  muted: boolean
  moderationReason?: string
  joinedAt: number
  name?: string
  displayName?: string
  photoUrl?: string
}

type BannedMember = {
  membershipId: string
  userId: string
  role: 'owner' | 'moderator' | 'member'
  moderationReason?: string
  updatedAt: number
  name?: string
  displayName?: string
  photoUrl?: string
}

type BondfireData = Doc<'bondfires'> & {
  isLive?: boolean
  livePlaybackId?: string
}

const REJECTION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

function getAccessLabel(camp: Doc<'camps'>) {
  if (camp.access === 'invite') return 'Invite only'
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
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      <Text fontSize={12} color={'$color'} fontWeight="800">
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

function getRoleBadgeColor(role: string) {
  if (role === 'owner') return '$secondary'
  if (role === 'moderator') return '$warning'
  return '$placeholderColor'
}

function MemberRow({
  member,
  canModerate,
  onRemove,
  onBan,
}: {
  member: CampMember
  canModerate: boolean
  onRemove: (member: CampMember) => void
  onBan: (member: CampMember) => void
}) {
  const roleBadgeColor = getRoleBadgeColor(member.role)

  return (
    <XStack
      paddingHorizontal={14}
      paddingVertical={12}
      alignItems="center"
      gap={12}
      borderBottomWidth={1}
      borderBottomColor={'rgba(51, 53, 58, 0.25)'}
    >
      <YStack
        width={40}
        height={40}
        borderRadius={20}
        backgroundColor={'$backgroundHover'}
        borderWidth={1}
        borderColor={'$borderColor'}
        alignItems="center"
        justifyContent="center"
      >
        {member.role === 'owner' ? (
          <Shield size={18} color={'$secondary'} />
        ) : member.role === 'moderator' ? (
          <Shield size={18} color={'$warning'} />
        ) : null}
        {member.role === 'member' ? <Flame size={16} color={'$placeholderColor'} /> : null}
      </YStack>

      <YStack flex={1} gap={2}>
        <Text fontSize={15} fontWeight="900">
          {member.displayName || member.name || 'Unknown'}
        </Text>
        <XStack gap={6} alignItems="center">
          <YStack
            paddingHorizontal={8}
            paddingVertical={2}
            borderRadius={999}
            backgroundColor={`${roleBadgeColor}22`}
            borderWidth={1}
            borderColor={roleBadgeColor}
          >
            <Text fontSize={11} color={roleBadgeColor} fontWeight="800">
              {member.role}
            </Text>
          </YStack>
          <Text fontSize={11} color={'$placeholderColor'}>
            {getTimeAgo(member.joinedAt)}
          </Text>
        </XStack>
      </YStack>

      {canModerate ? (
        <XStack gap={8}>
          <Pressable onPress={() => onRemove(member)}>
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$error'}
              alignItems="center"
              justifyContent="center"
            >
              <UserX size={16} color={'$error'} />
            </YStack>
          </Pressable>
          <Pressable onPress={() => onBan(member)}>
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$warning'}
              alignItems="center"
              justifyContent="center"
            >
              <Ban size={16} color={'$warning'} />
            </YStack>
          </Pressable>
        </XStack>
      ) : null}
    </XStack>
  )
}

function CampHeader({
  camp,
  onBack,
  onJoin,
  onMute,
  onCreateInvite,
  onSpark,
  canCreate,
  onUpgradeHint,
  pendingRequests,
  onApprove,
  onReject,
  members,
  bannedMembers,
  onRemoveMember,
  onBanMember,
  onUnbanMember,
  onArchive,
  currentUserId,
}: {
  camp: CampWithMembership
  onBack: () => void
  onJoin: () => void
  onMute: () => void
  onCreateInvite: () => void
  onSpark: () => void
  canCreate: boolean
  onUpgradeHint: () => void
  pendingRequests: PendingRequest[]
  onApprove: (membershipId: string) => void
  onReject: (membershipId: string) => void
  members: CampMember[] | undefined
  bannedMembers: BannedMember[] | undefined
  onRemoveMember: (member: CampMember) => void
  onBanMember: (member: CampMember) => void
  onUnbanMember: (membershipId: string) => void
  onArchive: () => void
  currentUserId?: string
}) {
  const isActiveMember = camp.membership?.status === 'active'
  const isPending = camp.membership?.status === 'pending'
  const isRejected = camp.membership?.status === 'rejected'
  const isOwner = isActiveMember && camp.membership?.role === 'owner'
  const isManager =
    isActiveMember && (camp.membership?.role === 'owner' || camp.membership?.role === 'moderator')
  const canModerateMember = useCallback(
    (member: CampMember | BannedMember) =>
      member.userId !== currentUserId &&
      member.role !== 'owner' &&
      (camp.membership?.role === 'owner' || member.role === 'member'),
    [camp.membership?.role, currentUserId],
  )
  const [bannedExpanded, setBannedExpanded] = useState(false)
  const muted = camp.membership?.muted === true
  const isFrozen = camp.frozen === true || camp.status === 'frozen'
  const isArchived = camp.status === 'archived'
  const rules = camp.rules
  const firstVisitBanner = getFirstVisitBanner(camp)

  const rejectedAt = camp.membership?.rejectedAt
  const cooldownExpired =
    isRejected && rejectedAt != null && Date.now() - rejectedAt >= REJECTION_COOLDOWN_MS
  const isInCooldown = isRejected && !cooldownExpired
  const cooldownEndDate = rejectedAt != null ? new Date(rejectedAt + REJECTION_COOLDOWN_MS) : null

  const canJoin = !isActiveMember && !isPending && !isInCooldown && camp.access !== 'invite'
  const accentColor = camp.accentColor ?? '$primary'
  const coverImageUrl = camp.coverImageUrl

  return (
    <YStack paddingTop={58} paddingHorizontal={16} paddingBottom={18} gap={18}>
      {coverImageUrl ? (
        <YStack height={180} marginHorizontal={-16} marginTop={-58} overflow="hidden">
          <TamaguiImage
            source={{ uri: coverImageUrl }}
            width="100%"
            height="100%"
            resizeMode="cover"
          />
          <YStack
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            height={60}
            backgroundColor={'rgba(20, 20, 22, 0.8)'}
          />
        </YStack>
      ) : null}
      {isFrozen ? (
        <YStack
          backgroundColor={'rgba(245, 158, 11, 0.13)'}
          borderColor={'$warning'}
          borderWidth={1}
          borderRadius={12}
          padding={12}
        >
          <Text color={'$warning'} fontSize={14} fontWeight="600">
            🔒 This camp is frozen
          </Text>
          <Text color={'$placeholderColor'} fontSize={12} marginTop={4}>
            No new videos can be created here. Upgrade to manage this camp.
          </Text>
        </YStack>
      ) : null}
      {isArchived ? (
        <YStack
          backgroundColor={'rgba(239, 68, 68, 0.13)'}
          borderColor={'$error'}
          borderWidth={1}
          borderRadius={12}
          padding={12}
        >
          <Text color={'$error'} fontSize={14} fontWeight="600">
            📦 This camp has been archived
          </Text>
          <Text color={'$placeholderColor'} fontSize={12} marginTop={4}>
            This camp is read-only. Content will be permanently deleted 30 days after archival.
          </Text>
        </YStack>
      ) : null}
      <XStack alignItems="center" justifyContent="space-between">
        <Pressable onPress={onBack}>
          <YStack
            width={42}
            height={42}
            borderRadius={21}
            alignItems="center"
            justifyContent="center"
            backgroundColor={'$backgroundHover'}
            borderWidth={1}
            borderColor={'$borderColor'}
          >
            <ArrowLeft size={22} color={'$color'} />
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
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={muted ? '$warning' : '$borderColor'}
            >
              {muted ? (
                <BellOff size={20} color={'$warning'} />
              ) : (
                <Bell size={20} color={'$color'} />
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
          backgroundColor={camp.color ?? '$backgroundHover'}
          alignItems="center"
          justifyContent="center"
        >
          {camp.access === 'invite' ? (
            <Lock size={32} color={'$color'} />
          ) : (
            <Flame size={36} color={'$color'} />
          )}
        </YStack>

        <YStack flex={1} gap={4}>
          <Text fontSize={26} fontWeight="900" numberOfLines={2}>
            {camp.name}
          </Text>
          <Text fontSize={14} color={'$placeholderColor'}>
            {camp.theme ?? getAccessLabel(camp)}
          </Text>
        </YStack>
      </XStack>

      <Text fontSize={15} color={'$color'} lineHeight={22}>
        {camp.purpose}
      </Text>

      {firstVisitBanner ? (
        <YStack
          padding={14}
          borderRadius={16}
          backgroundColor={'$backgroundPress'}
          borderWidth={1}
          borderColor={camp.color ?? '$borderColor'}
          gap={6}
        >
          <Text fontSize={12} color={'$secondary'} fontWeight="900">
            {firstVisitBanner.title}
          </Text>
          <Text fontSize={14} color={'$color'} lineHeight={20}>
            {firstVisitBanner.body}
          </Text>
        </YStack>
      ) : null}

      <XStack flexWrap="wrap" gap={8}>
        <RulePill label={getAccessLabel(camp)} />
        <RulePill label={[camp.activeMemberCount ?? 0, 'members'].join(' ')} />
        {rules.access.gender?.value ? (
          <RulePill
            label={rules.access.gender.value === 'any' ? 'All genders' : rules.access.gender.value}
          />
        ) : null}
        {rules.participation.maxDurationMs ? (
          <RulePill
            label={['Max', Math.round(rules.participation.maxDurationMs / 60000), 'min'].join(' ')}
          />
        ) : null}
        {rules.advisory.requiresTradeTags ? <RulePill label="Need/offer tags" /> : null}
      </XStack>

      {camp.defaultPrompt ? (
        <YStack
          padding={14}
          borderRadius={16}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$borderColor'}
          gap={6}
        >
          <Text fontSize={12} color={'$placeholderColor'} fontWeight="900">
            Prompt
          </Text>
          <Text fontSize={15} color={'$color'} lineHeight={21}>
            {camp.defaultPrompt}
          </Text>
        </YStack>
      ) : null}

      {isActiveMember && !isFrozen && !isArchived ? (
        <YStack gap={10}>
          {(camp.access !== 'invite' || isOwner) && canCreate ? (
            <Button variant="primary" size="$lg" onPress={onSpark} backgroundColor={accentColor}>
              <Flame size={20} color={'$color'} />
              <Text color={'$color'} fontWeight="900">
                Spark Here
              </Text>
            </Button>
          ) : null}
          {/* M4: free members see a soft invitation instead of a dead-end
              Spark button. It only shows where a paid member would have seen
              "Spark Here", and opens the explainer/paywall (never the camera). */}
          {(camp.access !== 'invite' || isOwner) && !canCreate ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Free members can respond here. Upgrade to Plus to spark your own Bondfires."
              onPress={onUpgradeHint}
            >
              <YStack
                padding={12}
                borderRadius={14}
                backgroundColor={'$backgroundHover'}
                borderWidth={1}
                borderColor={'$borderColor'}
                gap={2}
              >
                <Text fontSize={13} color={'$color'} fontWeight="900">
                  Free members can join and respond here
                </Text>
                <Text fontSize={12} color={'$primary'} fontWeight="900">
                  Spark your own with Plus →
                </Text>
              </YStack>
            </Pressable>
          ) : null}
          {isOwner && camp.access === 'invite' ? (
            <Button variant="outline" size="$lg" onPress={onCreateInvite}>
              <Text color={'$color'} fontWeight="900">
                Create Invite Code
              </Text>
            </Button>
          ) : null}
        </YStack>
      ) : null}

      {!isArchived && canJoin ? (
        <Button variant="primary" size="$lg" onPress={onJoin}>
          <Text color={'$color'} fontWeight="900">
            {cooldownExpired
              ? 'Request to Join Again'
              : camp.access === 'approval'
                ? 'Request to Join'
                : 'Join Camp'}
          </Text>
        </Button>
      ) : null}

      {isPending ? (
        <YStack
          padding={12}
          borderRadius={14}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$warning'}
        >
          <Text color={'$warning'} fontWeight="900" textAlign="center">
            Request pending — awaiting camp owner approval
          </Text>
        </YStack>
      ) : null}

      {isInCooldown ? (
        <YStack
          padding={12}
          borderRadius={14}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$error'}
        >
          <Text color={'$error'} fontWeight="900" textAlign="center">
            Request denied — you can try again on{' '}
            {cooldownEndDate?.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </Text>
        </YStack>
      ) : null}

      {/* Owner: Pending access request queue */}
      {isOwner && pendingRequests.length > 0 ? (
        <YStack gap={12}>
          <Text fontSize={14} color={'$secondary'} fontWeight="900">
            Pending Requests ({pendingRequests.length})
          </Text>
          {pendingRequests.map((req) => (
            <YStack
              key={req.membershipId}
              padding={14}
              borderRadius={14}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$borderColor'}
              gap={10}
            >
              <XStack alignItems="center" justifyContent="space-between" gap={10}>
                <YStack flex={1} gap={2}>
                  <Text fontSize={15} fontWeight="900">
                    {req.displayName || req.userName}
                  </Text>
                  <Text fontSize={12} color={'$placeholderColor'}>
                    {getTimeAgo(req.requestedAt)}
                  </Text>
                </YStack>
                <XStack gap={8}>
                  <Button variant="outline" size="$sm" onPress={() => onReject(req.membershipId)}>
                    <Text color={'$error'} fontWeight="900">
                      Deny
                    </Text>
                  </Button>
                  <Button variant="primary" size="$sm" onPress={() => onApprove(req.membershipId)}>
                    <Text color={'$color'} fontWeight="900">
                      Approve
                    </Text>
                  </Button>
                </XStack>
              </XStack>
            </YStack>
          ))}
        </YStack>
      ) : null}

      {/* Manager: Member management section */}
      {isManager && members !== undefined ? (
        <YStack gap={12}>
          <Text fontSize={14} color={'$secondary'} fontWeight="900">
            Members ({members.length})
          </Text>
          <YStack
            borderRadius={14}
            backgroundColor={'$backgroundHover'}
            borderWidth={1}
            borderColor={'$borderColor'}
            overflow="hidden"
          >
            {members.map((member) => (
              <MemberRow
                key={member.membershipId}
                member={member}
                canModerate={canModerateMember(member)}
                onRemove={onRemoveMember}
                onBan={onBanMember}
              />
            ))}
          </YStack>
        </YStack>
      ) : null}

      {/* Manager: Banned members section */}
      {isManager && bannedMembers !== undefined ? (
        <YStack gap={8}>
          <Pressable onPress={() => setBannedExpanded(!bannedExpanded)}>
            <XStack alignItems="center" gap={6}>
              <Text fontSize={13} color={'$error'} fontWeight="900">
                Banned Members ({bannedMembers.length})
              </Text>
              {bannedExpanded ? (
                <ChevronUp size={14} color={'$error'} />
              ) : (
                <ChevronDown size={14} color={'$error'} />
              )}
            </XStack>
          </Pressable>
          {bannedExpanded ? (
            <YStack
              borderRadius={14}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'rgba(239, 68, 68, 0.25)'}
              overflow="hidden"
            >
              {bannedMembers.map((banned) => (
                <YStack
                  key={banned.membershipId}
                  paddingHorizontal={14}
                  paddingVertical={12}
                  gap={6}
                  borderBottomWidth={1}
                  borderBottomColor={'rgba(51, 53, 58, 0.25)'}
                >
                  <XStack alignItems="center" justifyContent="space-between">
                    <YStack flex={1} gap={2}>
                      <Text fontSize={15} fontWeight="900">
                        {banned.displayName || banned.name || 'Unknown'}
                      </Text>
                      {banned.moderationReason ? (
                        <Text fontSize={12} color={'$placeholderColor'} numberOfLines={2}>
                          Reason: {banned.moderationReason}
                        </Text>
                      ) : null}
                      <Text fontSize={11} color={'$placeholderColor'}>
                        Banned {getTimeAgo(banned.updatedAt)}
                      </Text>
                    </YStack>
                    {canModerateMember(banned) ? (
                      <Pressable onPress={() => onUnbanMember(banned.membershipId)}>
                        <YStack
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={10}
                          backgroundColor={'$backgroundHover'}
                          borderWidth={1}
                          borderColor={'$primary'}
                        >
                          <Text fontSize={12} color={'$primary'} fontWeight="900">
                            Unban
                          </Text>
                        </YStack>
                      </Pressable>
                    ) : null}
                  </XStack>
                </YStack>
              ))}
              {bannedMembers.length === 0 ? (
                <YStack padding={16} alignItems="center">
                  <Text fontSize={13} color={'$placeholderColor'}>
                    No banned members
                  </Text>
                </YStack>
              ) : null}
            </YStack>
          ) : null}
        </YStack>
      ) : null}

      {/* Owner: Archive camp button */}
      {isOwner && !isArchived ? (
        <YStack paddingTop={8}>
          <Button variant="outline" size="$lg" onPress={onArchive}>
            <Text color={'$error'} fontWeight="900">
              Archive Camp
            </Text>
          </Button>
          <Text fontSize={11} color={'$placeholderColor'} marginTop={4} textAlign="center">
            Archiving makes the camp read-only. Content will be permanently deleted after 30 days.
          </Text>
        </YStack>
      ) : null}
    </YStack>
  )
}

function BondfireRow({
  bondfire,
  onOpen,
  rightActions,
}: {
  bondfire: BondfireData
  onOpen: () => void
  rightActions?: SwipeAction[]
}) {
  const responses = Math.max(0, bondfire.videoCount - 1)

  const row = (
    <Pressable onPress={onOpen}>
      <XStack paddingHorizontal={16} paddingVertical={13} gap={12} alignItems="center">
        <YStack
          width={50}
          height={50}
          borderRadius={15}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$borderColor'}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={24} color={'$primary'} />
        </YStack>

        <YStack flex={1} gap={4}>
          <Text fontSize={16} fontWeight="900" numberOfLines={1}>
            {bondfire.title?.trim() || `${bondfire.creatorName ?? 'Anonymous'}'s Bondfire`}
          </Text>
          <Text fontSize={12} color={'$placeholderColor'}>
            {bondfire.creatorName ? `${bondfire.creatorName} · ` : ''}{bondfire.videoStatus === 'live' ? 'Live now' : getTimeAgo(bondfire.createdAt)}
          </Text>
        </YStack>

        <XStack alignItems="center" gap={6}>
          <MessageCircle size={15} color={'$placeholderColor'} />
          <Text fontSize={13} color={'$placeholderColor'}>
            {responses}
          </Text>
        </XStack>
      </XStack>
    </Pressable>
  )

  if (rightActions && rightActions.length > 0) {
    return (
      <SwipeableRow actions={[]} rightActions={rightActions}>
        {row}
      </SwipeableRow>
    )
  }

  return row
}

export default function CampDetailScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const { canCreate } = useSubscription()
  const navigation = useNavigation()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const campId = id as Id<'camps'> | undefined
  const camp = useQuery(api.camps.get, campId ? { campId } : 'skip')
  const bondfires = useQuery(api.bondfires.listByCamp, campId ? { campId, limit: 50 } : 'skip')
  const canReviewAccessRequests =
    camp?.membership?.status === 'active' && camp.membership.role === 'owner'
  const isManager =
    camp?.membership?.status === 'active' &&
    (camp.membership.role === 'owner' || camp.membership.role === 'moderator')
  const isOwner = camp?.membership?.status === 'active' && camp.membership.role === 'owner'
  const pendingRequests: PendingRequest[] =
    useQuery(
      api.camps.getPendingRequests,
      campId && canReviewAccessRequests && camp?.status === 'active' ? { campId } : 'skip',
    ) ?? []
  const members: CampMember[] | undefined = useQuery(
    api.camps.listCampMembers,
    campId && isManager ? { campId } : 'skip',
  )
  const bannedMembers: BannedMember[] | undefined = useQuery(
    api.camps.getBannedMembers,
    campId && isManager ? { campId } : 'skip',
  )
  const joinCamp = useMutation(api.camps.join)
  const requestJoinCamp = useMutation(api.camps.requestJoin)
  const muteCamp = useMutation(api.camps.muteCamp)
  const approveAccess = useMutation(api.camps.approveAccessRequest)
  const rejectAccess = useMutation(api.camps.rejectAccessRequest)
  const removeMember = useMutation(api.camps.removeMember)
  const banMember = useMutation(api.camps.banMember)
  const unbanMember = useMutation(api.camps.unbanMember)
  const archiveCamp = useMutation(api.camps.archiveCamp)
  const [banReasonModalMember, setBanReasonModalMember] = useState<CampMember | null>(null)
  const [banReason, setBanReason] = useState('')
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false)
  const [archiveConfirmText, setArchiveConfirmText] = useState('')
  const [isInviteSheetOpen, setIsInviteSheetOpen] = useState(false)
  const { editingBondfire, openEditTitleSheet, closeEditTitleSheet } = useEditTitleSheet()

  const handleJoin = useCallback(async () => {
    if (!campId) return
    try {
      const result =
        camp?.access === 'approval' ? await requestJoinCamp({ campId }) : await joinCamp({ campId })
      if (result.status === 'pending') {
        Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
        return
      }
      appActions.setCurrentCampId(campId)
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Camp Unavailable', message)
    }
  }, [camp, campId, joinCamp, requestJoinCamp])

  const handleMute = useCallback(async () => {
    if (!camp || !campId || !camp.membership) return
    await muteCamp({ campId, muted: !camp.membership.muted })
  }, [camp, campId, muteCamp])

  const handleSpark = useCallback(() => {
    if (!campId) return
    appActions.setCurrentCampId(campId)
    // Straight to recording — the title is edited post-record on the
    // completion screen.
    router.push(routes.createForCamp(campId))
  }, [campId, router])

  const handleUpgradeHint = useCallback(() => {
    freeUpgradeActions.openExplainer('camp_detail')
  }, [])

  const handleCreateInvite = useCallback(() => {
    setIsInviteSheetOpen(true)
  }, [])

  const handleApprove = useCallback(
    async (membershipId: string) => {
      try {
        await approveAccess({ membershipId: membershipId as Id<'campMembers'> })
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Approval Failed', message)
      }
    },
    [approveAccess],
  )

  const handleReject = useCallback(
    async (membershipId: string) => {
      try {
        await rejectAccess({ membershipId: membershipId as Id<'campMembers'> })
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Rejection Failed', message)
      }
    },
    [rejectAccess],
  )

  const handleRemoveMember = useCallback(
    (member: CampMember) => {
      Alert.alert(
        'Remove Member',
        [
          'Are you sure you want to remove ',
          member.displayName || member.name,
          ' from this camp? They can rejoin or re-request.',
        ].join(''),
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              try {
                await removeMember({ membershipId: member.membershipId as Id<'campMembers'> })
              } catch (error) {
                const message = parseError(error).message
                Alert.alert('Remove Failed', message)
              }
            },
          },
        ],
      )
    },
    [removeMember],
  )

  const handleBanMember = useCallback((member: CampMember) => {
    setBanReasonModalMember(member)
    setBanReason('')
  }, [])

  const handleConfirmBan = useCallback(async () => {
    const member = banReasonModalMember
    if (!member) return
    try {
      await banMember({
        membershipId: member.membershipId as Id<'campMembers'>,
        reason: banReason.trim() || undefined,
      })
      setBanReasonModalMember(null)
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Ban Failed', message)
    }
  }, [banMember, banReasonModalMember, banReason])

  const handleUnbanMember = useCallback(
    (membershipId: string) => {
      Alert.alert('Unban Member', 'This will remove the ban. The user can rejoin or re-request.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unban',
          onPress: async () => {
            try {
              await unbanMember({ membershipId: membershipId as Id<'campMembers'> })
            } catch (error) {
              const message = parseError(error).message
              Alert.alert('Unban Failed', message)
            }
          },
        },
      ])
    },
    [unbanMember],
  )

  const handleArchive = useCallback(() => {
    setArchiveConfirmText('')
    setIsArchiveModalOpen(true)
  }, [])

  const handleConfirmArchive = useCallback(async () => {
    if (archiveConfirmText.trim() !== 'Archive Camp') return
    if (!campId) return
    try {
      await archiveCamp({ campId })
      setIsArchiveModalOpen(false)
      setArchiveConfirmText('')
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Archive Failed', message)
    }
  }, [archiveCamp, archiveConfirmText, campId])

  const handleOpenBondfire = useCallback(
    (bondfireId: string) => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      appActions.setVideoMuted(false)
      router.push(routes.bondfire(bondfireId))
    },
    [router],
  )

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  if (camp === undefined || bondfires === undefined) {
    return (
      <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
        <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
        <Spinner size="large" color={'$primary'} />
        <Text marginTop={18} color={'$placeholderColor'}>
          Loading camp...
        </Text>
      </YStack>
    )
  }

  if (!camp) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        padding={24}
        justifyContent="center"
        gap={16}
      >
        <Text fontSize={22} fontWeight="900" textAlign="center">
          Camp unavailable
        </Text>
        <Button variant="primary" size="$lg" onPress={handleBack}>
          <Text color={'$color'} fontWeight="900">
            Go Back
          </Text>
        </Button>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />
      <FlatList
        data={bondfires ?? []}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => {
          const isBondfireOwner = item.userId === camp.membership?.userId
          return (
            <BondfireRow
              bondfire={item}
              onOpen={() => handleOpenBondfire(item._id)}
              rightActions={getBondfireRightSwipeActions({
                isOwner: isBondfireOwner,
                onEdit: () =>
                  openEditTitleSheet(item._id, item.title ?? '', item.creatorName ?? undefined),
              })}
            />
          )
        }}
        ItemSeparatorComponent={() => (
          <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <>
            <CampHeader
              camp={camp}
              onBack={handleBack}
              onJoin={handleJoin}
              onMute={handleMute}
              onCreateInvite={handleCreateInvite}
              onSpark={handleSpark}
              canCreate={canCreate}
              onUpgradeHint={handleUpgradeHint}
              pendingRequests={pendingRequests}
              onApprove={handleApprove}
              onReject={handleReject}
              members={members}
              bannedMembers={bannedMembers}
              onRemoveMember={handleRemoveMember}
              onBanMember={handleBanMember}
              onUnbanMember={handleUnbanMember}
              onArchive={handleArchive}
              currentUserId={camp.membership?.userId}
            />
            {isOwner ? <OwnerCampSections camp={camp} /> : null}
          </>
        }
        ListEmptyComponent={
          <YStack paddingVertical={64} paddingHorizontal={32} alignItems="center" gap={12}>
            <Flame size={54} color={'$primary'} />
            <Text fontSize={19} fontWeight="900" textAlign="center">
              No Bondfires yet
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={21}>
              This camp is ready. The first spark will set the tone.
            </Text>
          </YStack>
        }
        contentContainerStyle={{ paddingBottom: 42 }}
      />

      {/* Ban reason modal */}
      <Modal
        visible={banReasonModalMember !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setBanReasonModalMember(null)}
      >
        <YStack
          flex={1}
          backgroundColor="rgba(0,0,0,0.7)"
          alignItems="center"
          justifyContent="center"
          padding={24}
        >
          <YStack
            backgroundColor={'$backgroundPress'}
            borderRadius={16}
            padding={20}
            gap={16}
            width="100%"
            maxWidth={400}
          >
            <YStack gap={4}>
              <Text fontSize={18} fontWeight="900">
                Ban Member
              </Text>
              <Text fontSize={14} color={'$placeholderColor'}>
                {banReasonModalMember
                  ? `Ban ${banReasonModalMember.displayName || banReasonModalMember.name || 'this member'} from this camp?`
                  : ''}
              </Text>
            </YStack>

            <TextInput
              style={{
                backgroundColor: colors.backgroundHover,
                borderWidth: 1,
                borderColor: colors.borderColor,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 12,
                color: colors.color,
                fontSize: 15,
              }}
              placeholder="Reason (optional)"
              placeholderTextColor={colors.placeholderColor}
              value={banReason}
              onChangeText={setBanReason}
              maxLength={500}
              multiline
            />

            <XStack gap={10}>
              <Button
                variant="outline"
                flex={1}
                size="$lg"
                onPress={() => setBanReasonModalMember(null)}
              >
                <Text color={'$color'} fontWeight="900">
                  Cancel
                </Text>
              </Button>
              <Button variant="primary" flex={1} size="$lg" onPress={handleConfirmBan}>
                <Text color={'$color'} fontWeight="900">
                  Ban
                </Text>
              </Button>
            </XStack>
          </YStack>
        </YStack>
      </Modal>

      {/* Archive confirmation modal */}
      <Modal
        visible={isArchiveModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsArchiveModalOpen(false)}
      >
        <YStack
          flex={1}
          backgroundColor="rgba(0,0,0,0.7)"
          alignItems="center"
          justifyContent="center"
          padding={24}
        >
          <YStack
            backgroundColor={'$backgroundPress'}
            borderRadius={16}
            padding={20}
            gap={16}
            width="100%"
            maxWidth={400}
          >
            <YStack gap={4}>
              <Text fontSize={18} fontWeight="900">
                Archive Camp
              </Text>
              <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
                Archiving this camp will make it read-only for all members. After 30 days, all
                content will be permanently deleted. This cannot be undone.
              </Text>
            </YStack>

            <TextInput
              style={{
                backgroundColor: colors.backgroundHover,
                borderWidth: 1,
                borderColor: colors.borderColor,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 12,
                color: colors.color,
                fontSize: 15,
              }}
              placeholder='Type "Archive Camp" to confirm'
              placeholderTextColor={colors.placeholderColor}
              value={archiveConfirmText}
              onChangeText={setArchiveConfirmText}
              autoCapitalize="none"
            />

            <XStack gap={10}>
              <Button
                variant="outline"
                flex={1}
                size="$lg"
                onPress={() => setIsArchiveModalOpen(false)}
              >
                <Text color={'$color'} fontWeight="900">
                  Cancel
                </Text>
              </Button>
              <Button
                variant="primary"
                flex={1}
                size="$lg"
                disabled={archiveConfirmText.trim() !== 'Archive Camp'}
                onPress={handleConfirmArchive}
              >
                <Text color={'$color'} fontWeight="900">
                  Archive
                </Text>
              </Button>
            </XStack>
          </YStack>
        </YStack>
      </Modal>
      {campId ? (
        <InviteSheet
          mode="camp"
          id={campId as Id<'camps'>}
          open={isInviteSheetOpen}
          onClose={() => setIsInviteSheetOpen(false)}
        />
      ) : null}

      {/* Edit Title Sheet */}
      {editingBondfire && (
        <EditTitleSheet
          bondfireId={editingBondfire.id}
          currentTitle={editingBondfire.title}
          creatorName={editingBondfire.creatorName}
          open={true}
          onClose={closeEditTitleSheet}
        />
      )}
    </YStack>
  )
}
