import { parseError, useSubscription } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { AlertTriangle, Flame, Globe, Lock, Users } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import type { ComponentType } from 'react'
import { Alert, Pressable } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import {
  SegmentedControl,
  VisibilityPicker,
} from '../../../../../components/camps/CampSettingsControls'
import {
  CampSettingsScaffold,
  type OwnedCamp,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'
import {
  accessFromChoice,
  type CampJoinMode,
  type CampVisibilityChoice,
  choiceFromAccess,
} from '../../../../../lib/campSettings'

type IconType = ComponentType<{ size?: number; color?: string }>

function Consequence({
  icon: Icon,
  title,
  detail,
  warn,
}: {
  icon: IconType
  title: string
  detail: string
  warn?: boolean
}) {
  return (
    <XStack gap={12} alignItems="flex-start">
      <YStack
        width={34}
        height={34}
        borderRadius={10}
        backgroundColor={warn ? 'rgba(245,158,11,0.15)' : '$backgroundHover'}
        alignItems="center"
        justifyContent="center"
      >
        <Icon size={18} color={warn ? '$warning' : '$secondary'} />
      </YStack>
      <YStack flex={1} gap={2}>
        <Text fontSize={15} fontWeight="800">
          {title}
        </Text>
        <Text fontSize={13} color={'$placeholderColor'} lineHeight={18}>
          {detail}
        </Text>
      </YStack>
    </XStack>
  )
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function VisibilityForm({ camp }: { camp: OwnedCamp }) {
  const router = useRouter()
  const { currentTier } = useSubscription()
  const changeVisibility = useMutation(api.camps.changeCampVisibility)
  const pending = useQuery(api.camps.getPendingRequests, { campId: camp._id })
  const pendingCount = pending?.length ?? 0
  const current = choiceFromAccess(camp.access)
  const state$ = useObservable({
    choice: current,
    confirmOpen: false,
    isSaving: false,
  })
  const choice = useValue(state$.choice)
  const confirmOpen = useValue(state$.confirmOpen)
  const isSaving = useValue(state$.isSaving)

  const canChoosePublic = currentTier === 'pro'
  const switching = choice.visibility !== current.visibility
  const goingPublic = switching && choice.visibility === 'public'
  const memberCount = camp.activeMemberCount ?? 0
  const pastBondfires = camp.bondfireCount ?? 0

  const save = async (next: CampVisibilityChoice, afterSave?: () => void) => {
    state$.isSaving.set(true)
    try {
      await changeVisibility({ campId: camp._id, access: accessFromChoice(next) })
      afterSave?.()
    } catch (error) {
      state$.choice.set(choiceFromAccess(camp.access))
      Alert.alert('Couldn’t change visibility', parseError(error).message)
    } finally {
      state$.isSaving.set(false)
    }
  }

  const handleChange = (next: CampVisibilityChoice) => {
    const stayingPublic = next.visibility === 'public' && current.visibility === 'public'
    // Join mode on a camp that's already public saves right away.
    if (stayingPublic && next.join !== current.join) {
      const apply = () => {
        state$.choice.set(next)
        void save(next)
      }
      if (next.join === 'open' && pendingCount > 0) {
        Alert.alert(
          'Approve pending requests?',
          `Opening the camp lets in the ${plural(pendingCount, 'person', 'people')} waiting for approval.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open camp', onPress: apply },
          ],
        )
        return
      }
      apply()
      return
    }
    state$.choice.set(next)
  }

  return (
    <YStack gap={16}>
      <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
        Who can find {camp.name}, and how they get in.
      </Text>
      <VisibilityPicker
        value={choice}
        onChange={handleChange}
        canChoosePublic={canChoosePublic || current.visibility === 'public'}
        currentVisibility={current.visibility}
      />
      {switching ? (
        <Button
          variant="primary"
          size="$lg"
          disabled={isSaving}
          onPress={() => state$.confirmOpen.set(true)}
        >
          <Text color={'$color'} fontWeight="900">
            Continue
          </Text>
        </Button>
      ) : (
        <Text fontSize={12} color={'$placeholderColor'} textAlign="center" lineHeight={17}>
          {current.visibility === 'public'
            ? 'Join setting changes save right away. Switching to Private asks you to confirm first.'
            : 'Switching to Public asks you to confirm first.'}
        </Text>
      )}
      <Text fontSize={12} color={'$placeholderColor'} textAlign="center">
        Switching costs no extra kindling.
      </Text>

      <Sheet
        modal
        open={confirmOpen}
        onOpenChange={(open: boolean) => state$.confirmOpen.set(open)}
        snapPointsMode="fit"
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.55)" />
        <Sheet.Frame padding={20} backgroundColor={'$backgroundPress'} gap={18}>
          <Sheet.Handle backgroundColor={'$borderColor'} />
          <YStack gap={6}>
            <Text fontSize={22} fontWeight="900">
              {goingPublic ? `Make ${camp.name} public?` : `Make ${camp.name} private?`}
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
              Here’s what changes for the {plural(memberCount, 'person', 'people')} already in it.
            </Text>
          </YStack>

          {goingPublic ? (
            <YStack gap={14}>
              <Consequence
                icon={Globe}
                title="Anyone can find it in Browse"
                detail="Your camp rules still decide who can join."
              />
              {pastBondfires > 0 ? (
                <Consequence
                  icon={AlertTriangle}
                  warn
                  title={`New members can watch ${pastBondfires === 1 ? 'the' : `all ${pastBondfires}`} past ${pastBondfires === 1 ? 'Bondfire' : 'Bondfires'}`}
                  detail="Including ones your members posted while it was private."
                />
              ) : null}
              <Consequence
                icon={Flame}
                title="Members with Plus can spark"
                detail="Not just you. Everyone can still respond."
              />
              <YStack gap={8}>
                <Text fontSize={12} fontWeight="900" color={'$placeholderColor'}>
                  HOW PEOPLE JOIN
                </Text>
                <SegmentedControl<CampJoinMode>
                  accessibilityLabel="How people join"
                  options={[
                    { value: 'open', label: 'Open' },
                    { value: 'approval', label: 'Approval required' },
                  ]}
                  value={choice.join}
                  onChange={(join) => state$.choice.set({ ...choice, join })}
                />
              </YStack>
            </YStack>
          ) : (
            <YStack gap={14}>
              <Consequence
                icon={Flame}
                warn
                title="Only you can spark here"
                detail="Members can still watch and respond, but can’t start new Bondfires. Their past ones stay."
              />
              <Consequence
                icon={Lock}
                title="It leaves Browse"
                detail="New people join with an invite code you share."
              />
              <Consequence
                icon={Users}
                title={`All ${plural(memberCount, 'member', 'members')} stay`}
                detail={
                  pendingCount > 0
                    ? `${plural(pendingCount, 'pending request', 'pending requests')} will be removed.`
                    : 'Nobody is removed.'
                }
              />
            </YStack>
          )}

          <YStack gap={10}>
            <Button
              variant="primary"
              size="$lg"
              disabled={isSaving}
              onPress={() =>
                save(choice, () => {
                  state$.confirmOpen.set(false)
                  router.back()
                })
              }
            >
              {isSaving ? (
                <Spinner color={'$color'} />
              ) : (
                <Text color={'$color'} fontWeight="900">
                  {goingPublic ? 'Make public' : 'Make private'}
                </Text>
              )}
            </Button>
            <Pressable
              accessibilityRole="button"
              onPress={() => state$.confirmOpen.set(false)}
              style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text fontSize={15} fontWeight="800">
                Cancel
              </Text>
            </Pressable>
          </YStack>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  )
}

export default function CampVisibilitySettingsScreen() {
  const { campId, camp } = useOwnedCamp()
  return (
    <CampSettingsScaffold title="Visibility" campId={campId} camp={camp} backTo="settings">
      {(owned) => <VisibilityForm camp={owned} />}
    </CampSettingsScaffold>
  )
}
