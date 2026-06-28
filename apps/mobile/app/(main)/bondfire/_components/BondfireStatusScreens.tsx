import { Spinner, Text } from '@bondfires/ui'
import { ChevronLeft, Flame } from '@tamagui/lucide-icons'
import { Stack } from 'expo-router'
import type { Animated as AnimatedType } from 'react-native'
import { Animated, Pressable, StatusBar, type StatusBarStyle } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { BondfireDetailData } from '../_lib/bondfireDetailHelpers'

type BackProps = {
  statusBarStyle: StatusBarStyle
  backgroundColor: string
  onBackPress: () => void
}

function StatusShell({
  statusBarStyle,
  backgroundColor,
  onBackPress,
  children,
}: BackProps & {
  children: React.ReactNode
}) {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
      <YStack flex={1} backgroundColor={'$background'} paddingHorizontal={24}>
        <Pressable onPress={onBackPress}>
          <XStack alignItems="center" gap={6} paddingTop={50} paddingBottom={12}>
            <ChevronLeft size={22} color={'$color'} />
            <Text color={'$color'} fontWeight="800">
              Campground
            </Text>
          </XStack>
        </Pressable>

        {children}
      </YStack>
    </>
  )
}

export function BondfireLoadingScreen() {
  return (
    <YStack flex={1} backgroundColor={'$background'} alignItems="center" justifyContent="center">
      <Spinner size="large" color={'$primary'} />
    </YStack>
  )
}

export function BondfireUnavailableScreen(props: BackProps) {
  return (
    <StatusShell {...props}>
      <YStack flex={1} alignItems="center" justifyContent="center" gap={16}>
        <Flame size={44} color={'$placeholderColor'} />
        <Text fontSize={22} fontWeight="900" textAlign="center">
          This Bondfire isn't available
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
          It may have expired, been removed, or its recording failed to process.
        </Text>
      </YStack>
    </StatusShell>
  )
}

export function BondfirePendingScreen({
  bondfireData,
  pendingPulse,
  ...props
}: BackProps & {
  bondfireData: BondfireDetailData
  pendingPulse: AnimatedType.Value
}) {
  const creatorName = bondfireData.creatorName ?? 'Someone'

  return (
    <StatusShell {...props}>
      <YStack flex={1} justifyContent="center" gap={22}>
        <Animated.View style={{ opacity: pendingPulse }}>
          <YStack
            width={96}
            height={96}
            borderRadius={28}
            backgroundColor={'$backgroundHover'}
            borderWidth={1}
            borderColor={'$primary'}
            alignItems="center"
            justifyContent="center"
            alignSelf="center"
          >
            <Flame size={44} color={'$primary'} />
          </YStack>
        </Animated.View>

        <YStack gap={8} alignItems="center">
          <Text fontSize={24} fontWeight="900" textAlign="center">
            {bondfireData.title ?? `${creatorName}'s Bondfire`}
          </Text>
          <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
            {[creatorName, bondfireData.campName].filter(Boolean).join(' • ')}
          </Text>
        </YStack>

        <Text fontSize={17} color={'$color'} textAlign="center" lineHeight={24}>
          Waiting for {creatorName} to start recording...
        </Text>
      </YStack>
    </StatusShell>
  )
}

export function BondfireProcessingScreen(props: BackProps) {
  return (
    <StatusShell {...props}>
      <YStack flex={1} alignItems="center" justifyContent="center" gap={16}>
        <Spinner size="large" color={'$primary'} />
        <Text fontSize={22} fontWeight="900">
          Processing...
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
          The recording will play as soon as it is ready.
        </Text>
      </YStack>
    </StatusShell>
  )
}

export function BondfireErroredScreen({
  bondfireData,
  ...props
}: BackProps & {
  bondfireData: BondfireDetailData
}) {
  const creatorName = bondfireData.creatorName ?? 'Someone'

  return (
    <StatusShell {...props}>
      <YStack flex={1} alignItems="center" justifyContent="center" gap={16}>
        <Flame size={44} color={'$placeholderColor'} />
        <Text fontSize={22} fontWeight="900" textAlign="center">
          Recording failed
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
          {creatorName}'s recording didn't process correctly. They can try again.
        </Text>
      </YStack>
    </StatusShell>
  )
}
