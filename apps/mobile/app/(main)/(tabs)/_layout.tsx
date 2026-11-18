import {
  CREATE_REQUIRED_TIER,
  lastKnownTier$,
  subscriptionStore$,
  tierMeetsRequirement,
  useAppThemeColors,
  useSubscription,
} from '@bondfires/app'
import { Flame, Home, Map, User } from '@bondfires/ui/icons'
import { useValue } from '@legendapp/state/react'
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
    router.push(routes.createFresh())
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
          tabBarIcon: ({ color, size }) => <Map color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="my-fires"
        options={{
          // Do not use `href: null`. Expo Router 58 turns that into
          // `hidden: true`, then unmounts the tab navigator and redirects to
          // the first visible tab as soon as this screen is focused. Opening
          // All Fires from the Ember Rail never stays on this screen.
          // Hide the tab button only. Notifications and deep links still
          // target /(main)/(tabs)/my-fires (see EXTERNAL_STATIC_ROUTES).
          title: 'My Fires',
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none', width: 0, height: 0, flex: 0 },
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
          // for navigation state. Controlled legacy/deep-link inputs are
          // resolved in lib/routes.ts to the pushed create route; free users
          // never see this tab.
          href: showSparkTab ? undefined : null,
          title: 'Spark',
          tabBarIcon: ({ color, size }) => <Flame color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <User color={color as string} size={size} />,
        }}
      />
    </Tabs>
  )
}
