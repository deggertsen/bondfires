import { useAppThemeColors } from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { ChevronLeft, ChevronRight } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, StatusBar } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { goBackOrReplace } from '../../lib/navigation'
import { routes } from '../../lib/routes'
import { useHeaderTopPadding } from '../UploadStatusLayout'

export type OwnedCamp = Doc<'camps'> & { membership: Doc<'campMembers'> | null }

/**
 * Load the camp named by the route's `id` for a settings screen. `camp` is
 * undefined while loading and null when missing or not owned by the viewer.
 */
export function useOwnedCamp(): {
  campId: Id<'camps'> | undefined
  camp: OwnedCamp | null | undefined
} {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const campId = id as Id<'camps'> | undefined
  const camp = useQuery(api.camps.get, campId ? { campId } : 'skip')
  if (camp === undefined) return { campId, camp: undefined }
  const isOwner = camp?.membership?.status === 'active' && camp.membership.role === 'owner'
  return { campId, camp: camp && isOwner && camp.status === 'active' ? (camp as OwnedCamp) : null }
}

/**
 * Header, scrolling body and optional pinned footer shared by every camp
 * settings screen. Renders loading and not-owner states itself so screens
 * only render once they have an owned camp.
 */
export function CampSettingsScaffold({
  title,
  subtitle,
  campId,
  camp,
  backTo,
  footer,
  children,
}: {
  title: string
  subtitle?: string
  campId: Id<'camps'> | undefined
  camp: OwnedCamp | null | undefined
  /** Where back goes when there is no history: the camp or its settings. */
  backTo: 'camp' | 'settings'
  footer?: ReactNode
  children: (camp: OwnedCamp) => ReactNode
}) {
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const headerTopPadding = useHeaderTopPadding(58)
  const { statusBarStyle } = useAppThemeColors()

  const handleBack = () => {
    if (!campId) {
      goBackOrReplace(router, navigation, routes.camps)
      return
    }
    goBackOrReplace(
      router,
      navigation,
      backTo === 'camp' ? routes.camp(campId) : routes.campSettings(campId),
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <XStack
          alignItems="center"
          gap={12}
          paddingTop={headerTopPadding}
          paddingHorizontal={16}
          paddingBottom={12}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={handleBack}>
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
              <ChevronLeft size={22} color={'$color'} />
            </YStack>
          </Pressable>
          <YStack flex={1}>
            <Text fontSize={22} fontWeight="900" numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? (
              <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </YStack>
        </XStack>

        {camp === undefined ? (
          <YStack flex={1} alignItems="center" justifyContent="center">
            <Spinner size="large" color={'$primary'} />
          </YStack>
        ) : camp === null ? (
          <YStack flex={1} alignItems="center" justifyContent="center" padding={32} gap={8}>
            <Text fontSize={18} fontWeight="900" textAlign="center">
              Settings are unavailable
            </Text>
            <Text fontSize={14} color={'$placeholderColor'} textAlign="center">
              Only the owner of an active camp can change its settings.
            </Text>
          </YStack>
        ) : (
          <>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 18 }}
              keyboardShouldPersistTaps="handled"
            >
              {children(camp)}
            </ScrollView>
            {footer ? (
              <YStack
                paddingHorizontal={16}
                paddingTop={8}
                paddingBottom={insets.bottom + 12}
                gap={8}
              >
                {footer}
              </YStack>
            ) : null}
          </>
        )}
      </KeyboardAvoidingView>
    </YStack>
  )
}

/** A tappable settings row: label, optional detail, and a chevron. */
export function SettingsRow({
  label,
  value,
  detail,
  onPress,
  last,
}: {
  label: string
  value?: string
  detail?: string
  onPress: () => void
  last?: boolean
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityHint={detail ?? value} onPress={onPress}>
      <XStack
        alignItems="center"
        gap={10}
        minHeight={52}
        paddingHorizontal={14}
        paddingVertical={10}
        borderBottomWidth={last ? 0 : 1}
        borderBottomColor={'$borderColor'}
      >
        <YStack flex={1} gap={2}>
          <Text fontSize={15} fontWeight="700">
            {label}
          </Text>
          {detail ? (
            <Text fontSize={12} color={'$placeholderColor'} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
        </YStack>
        {value ? (
          <Text fontSize={14} color={'$placeholderColor'} numberOfLines={1} maxWidth={170}>
            {value}
          </Text>
        ) : null}
        <ChevronRight size={16} color={'$placeholderColor'} />
      </XStack>
    </Pressable>
  )
}

/** A rounded group of settings rows. */
export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <YStack
      borderRadius={14}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
      overflow="hidden"
    >
      {children}
    </YStack>
  )
}
