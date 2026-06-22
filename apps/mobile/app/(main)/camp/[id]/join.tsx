import { Button, Spinner, Text } from '@bondfires/ui'
import { ArrowLeft, Flame, Lock } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, ScrollView } from 'react-native'
import { Image as TamaguiImage, XStack, YStack } from 'tamagui'
import { api } from '../../../../../../convex/_generated/api'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import { routes } from '../../../../lib/routes'

/**
 * Full-screen camp join gate.
 *
 * Shown when a non-member tries to view or respond to a bondfire in a camp
 * they haven't joined.  Unlike the old dismissible bottom sheet, this screen
 * cannot be swiped away — the user must either join the camp or go back.
 *
 * Accepts a `redirect` param (a serialized Href or bondfire id) so that after
 * a successful join we can navigate the user to what they were trying to reach.
 */

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

function getAccessLabel(camp: { access: string }) {
  if (camp.access === 'invite') return 'Invite only'
  if (camp.access === 'approval') return 'Approval required'
  return 'Open'
}

export default function CampJoinGateScreen() {
  const router = useRouter()
  const { id, redirect } = useLocalSearchParams<{
    id: string
    redirect?: string
  }>()

  const campId = id as Id<'camps'>
  const camp = useQuery(api.camps.get, { campId })
  const joinCamp = useMutation(api.camps.join)
  const requestJoin = useMutation(api.camps.requestJoin)
  const [joining, setJoining] = useState(false)

  const isApprovalCamp = camp?.access === 'approval'
  const isInviteCamp = camp?.access === 'invite'

  const handleJoin = async () => {
    setJoining(true)
    try {
      if (isApprovalCamp) {
        await requestJoin({ campId })
        Alert.alert(
          'Request sent',
          'The camp owner will review your request. You can try again once approved.',
        )
        handleBack()
      } else {
        await joinCamp({ campId })
        // After joining, navigate to where they were trying to go.
        if (redirect) {
          // redirect is a bondfire id — navigate to that bondfire.
          router.replace(routes.bondfire(redirect))
        } else {
          router.replace(routes.camp(campId))
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong'
      Alert.alert('Could not join', message)
    } finally {
      setJoining(false)
    }
  }

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace(routes.feed)
    }
  }

  if (camp === undefined) {
    return (
      <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
        <Spinner size="large" />
      </YStack>
    )
  }

  if (camp === null) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        paddingHorizontal={32}
      >
        <Text fontSize={18} fontWeight="700" textAlign="center">
          Camp not found
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} textAlign="center" marginTop={8}>
          This camp may have been removed or is no longer available.
        </Text>
        <Button variant="primary" size="$lg" marginTop={24} onPress={handleBack}>
          Go Back
        </Button>
      </YStack>
    )
  }

  const rules = camp.rules
  const accentColor = camp.accentColor ?? '$primary'
  const coverImageUrl = camp.coverImageUrl

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: '$background' }}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {coverImageUrl ? (
          <YStack height={200} overflow="hidden">
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

        <YStack paddingHorizontal={20} paddingTop={50} paddingBottom={28} gap={18} flex={1}>
          {/* Back button */}
          <Pressable
            onPress={handleBack}
            style={{ position: 'absolute', top: 50, left: 16, zIndex: 10 }}
          >
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

          {/* Camp identity */}
          <XStack alignItems="center" gap={14} marginTop={coverImageUrl ? 0 : 10}>
            <YStack
              width={72}
              height={72}
              borderRadius={20}
              backgroundColor={camp.color ?? '$backgroundHover'}
              alignItems="center"
              justifyContent="center"
            >
              {isInviteCamp ? (
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

          {/* Description */}
          {camp.purpose ? (
            <Text fontSize={15} color={'$color'} lineHeight={22}>
              {camp.purpose}
            </Text>
          ) : null}

          {/* Default prompt */}
          {camp.defaultPrompt ? (
            <YStack
              padding={14}
              borderRadius={16}
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$borderColor'}
              gap={6}
            >
              <Text fontSize={12} color={'$secondary'} fontWeight="900">
                PROMPT
              </Text>
              <Text fontSize={14} color={'$color'} lineHeight={20}>
                {camp.defaultPrompt}
              </Text>
            </YStack>
          ) : null}

          {/* Rules */}
          <XStack flexWrap="wrap" gap={8}>
            <RulePill label={getAccessLabel(camp)} />
            <RulePill label={[camp.activeMemberCount ?? 0, 'members'].join(' ')} />
            {rules?.access?.gender?.value ? (
              <RulePill
                label={
                  rules.access.gender.value === 'any' ? 'All genders' : rules.access.gender.value
                }
              />
            ) : null}
            {rules?.participation?.maxDurationMs ? (
              <RulePill
                label={['Max', Math.round(rules.participation.maxDurationMs / 60000), 'min'].join(
                  ' ',
                )}
              />
            ) : null}
            {rules?.advisory?.requiresTradeTags ? <RulePill label="Need/offer tags" /> : null}
          </XStack>

          {/* Join message */}
          <YStack
            padding={16}
            borderRadius={16}
            backgroundColor={'$backgroundPress'}
            borderWidth={1}
            borderColor={accentColor}
            gap={8}
            marginTop={8}
          >
            <Text fontSize={16} fontWeight="800" textAlign="center">
              Join Camp to Continue
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={20}>
              {isApprovalCamp
                ? 'This camp requires approval. Request to join and the camp owner will review your request.'
                : isInviteCamp
                  ? 'This camp is invite-only. You need an invite to join.'
                  : "Join this camp to watch and respond to bondfires here. It's free and quick."}
            </Text>
          </YStack>

          {/* Actions */}
          <YStack gap={12} marginTop={8}>
            {!isInviteCamp ? (
              <Button
                variant="primary"
                size="$lg"
                width="100%"
                onPress={handleJoin}
                disabled={joining}
              >
                <Text color={'$color'} fontWeight="700">
                  {joining
                    ? isApprovalCamp
                      ? 'Sending request...'
                      : 'Joining...'
                    : isApprovalCamp
                      ? 'Request to Join'
                      : 'Join Camp'}
                </Text>
              </Button>
            ) : null}
            <Button variant="outline" size="$lg" width="100%" onPress={handleBack}>
              <Text color={'$color'} fontWeight="600">
                Go Back
              </Text>
            </Button>
          </YStack>
        </YStack>
      </ScrollView>
    </>
  )
}
