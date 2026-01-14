import { bondfireColors } from '@bondfires/config'
import { Flame, Home, User } from '@tamagui/lucide-icons'
import { Tabs } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export default function MainLayout() {
  const insets = useSafeAreaInsets()

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: bondfireColors.bondfireCopper,
        tabBarInactiveTintColor: bondfireColors.ash,
        tabBarStyle: {
          backgroundColor: bondfireColors.gunmetal,
          borderTopColor: bondfireColors.iron,
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
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
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
      <Tabs.Screen
        name="bondfire/[id]"
        options={{
          href: null, // Hide from tab bar
        }}
      />
    </Tabs>
  )
}
