import { bondfireColors } from '@bondfires/config'
import { Home, Flame, User } from '@tamagui/lucide-icons'
import { Tabs } from 'expo-router'

export default function MainLayout() {
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
          paddingBottom: 8,
          height: 60,
        },
        tabBarLabelStyle: {
          fontSize: 11,
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
