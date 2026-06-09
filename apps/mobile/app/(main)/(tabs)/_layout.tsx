import { appStore$, useAppThemeColors } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { Flame, Home, Map, MessageCircle, User } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { Tabs, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'
import { SparkTitleSheet } from '../../../components/SparkTitleSheet'
import { routes } from '../../../lib/routes'

type JoinedCamp = Doc<'camps'> & { membership: Doc<'campMembers'> }

export default function TabsLayout() {
  const insets = useSafeAreaInsets()
  const { colors } = useAppThemeColors()
  const router = useRouter()
  const currentUserId = useValue(appStore$.userId)
  const currentCampId = useValue(appStore$.currentCampId)
  const joinedCamps = useQuery(api.camps.listMine, currentUserId ? {} : 'skip') as
    | JoinedCamp[]
    | undefined
  const selectedCamp = joinedCamps?.find((camp) => camp._id === currentCampId)
  const [isSparkSheetOpen, setIsSparkSheetOpen] = useState(false)

  const openSparkSheet = useCallback(() => {
    setIsSparkSheetOpen(true)
  }, [])

  const handleSparkSubmit = useCallback(
    (title: string) => {
      setIsSparkSheetOpen(false)
      router.push(routes.createWithTitle(title, selectedCamp?._id))
    },
    [router, selectedCamp?._id],
  )

  return (
    <>
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
          name="create"
          listeners={{
            tabPress: (event) => {
              event.preventDefault()
              openSparkSheet()
            },
          }}
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
      </Tabs>
      <SparkTitleSheet
        open={isSparkSheetOpen}
        campId={selectedCamp?._id}
        campName={selectedCamp?.name}
        onSubmit={handleSparkSubmit}
        onCancel={() => setIsSparkSheetOpen(false)}
      />
    </>
  )
}
