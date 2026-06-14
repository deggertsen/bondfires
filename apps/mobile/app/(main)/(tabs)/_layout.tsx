import {
  CREATE_REQUIRED_TIER,
  lastKnownTier$,
  subscriptionStore$,
  tierMeetsRequirement,
  useAppThemeColors,
  useSubscription,
} from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { Flame, Home, Map, MessageCircle, User } from '@tamagui/lucide-icons'
import { Tabs, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { routes } from '../../../lib/routes'

export default function TabsLayout() {
  const insets = useSafeAreaInsets()
  const { colors } = useAppThemeColors()
  const router = useRouter()

  // Reactive source of truth for whether the user can spark (Plus+). Reading
  // `useSubscription` here keeps the tab count live: a mid-session upgrade or
  // lapse flips the Spark tab without an app restart (M13).
  const { canCreate } = useSubscription()
  const subscriptionResolved = useValue(subscriptionStore$.subscriptionResolved)
  const lastTier = useValue(lastKnownTier$.tier)

  // First-paint correctness (Edge Case 4): until the live subscription query
  // resolves, fall back to the persisted last-known tier so a returning free
  // user paints 4 tabs immediately with no 5→4 snap. Only a true first run (no
  // persisted tier) optimistically shows all 5 tabs, then reconciles on resolve.
  const showSparkTab = subscriptionResolved
    ? canCreate
    : lastTier != null
      ? tierMeetsRequirement(lastTier, CREATE_REQUIRED_TIER)
      : true

  const openSparkTab = useCallback(() => {
    router.push(routes.create)
  }, [router])

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.placeholderColor,
        tabBarStyle: {
          backgroundColor: colors.backgroundHover,
          borderTopColor: colors.borderColor,
          borderTopWidth: 1,
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom,
          height: 60 + insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 9,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="camps"
        options={{
          title: 'Camps',
          tabBarIcon: ({ color, size }) => <Map color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="my-fires"
        options={{
          title: 'My Fires',
          tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="spark"
        listeners={{
          tabPress: (event) => {
            event.preventDefault()
            openSparkTab()
          },
        }}
        options={{
          // `href: null` hides the tab while keeping the route addressable
          // (deep links, legacy affordances still resolve to the safety-net
          // block-CTA in LiveRecordScreen). Free users never see this tab.
          href: showSparkTab ? undefined : null,
          title: 'Spark',
          tabBarIcon: ({ color, size }) => <Flame color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
    </Tabs>
  )
}
