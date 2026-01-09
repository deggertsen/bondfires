import { appActions, usePreferences } from '@bondfires/app'
import { Button, Card, Container, Input, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { Edit3, LogOut, Settings } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, FlatList } from 'react-native'
import { Avatar, H1, Separator, Sheet, Spinner, Switch, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

export default function ProfileScreen() {
  const router = useRouter()
  const { signOut } = useAuthActions()

  const currentUser = useQuery(api.users.current)
  const userBondfires = useQuery(
    api.bondfires.listByUser,
    currentUser?._id ? { userId: currentUser._id } : 'skip',
  )
  const updateProfile = useMutation(api.users.updateProfile)

  const { preferences, setAutoplayVideos, setNotificationsEnabled } = usePreferences()

  const [isEditSheetOpen, setIsEditSheetOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const handleLogout = useCallback(async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut()
          appActions.logout()
          router.replace('/(auth)/login')
        },
      },
    ])
  }, [signOut, router])

  const handleEditProfile = useCallback(() => {
    setEditName(currentUser?.displayName ?? currentUser?.name ?? '')
    setIsEditSheetOpen(true)
  }, [currentUser])

  const handleSaveProfile = useCallback(async () => {
    setIsSaving(true)
    try {
      await updateProfile({
        displayName: editName,
      })
      setIsEditSheetOpen(false)
    } catch {
      Alert.alert('Error', 'Failed to update profile')
    } finally {
      setIsSaving(false)
    }
  }, [editName, updateProfile])

  if (!currentUser) {
    return (
      <Container centered>
        <Spinner size="large" color="$orange10" />
      </Container>
    )
  }

  const stats = {
    bondfireCount: currentUser.bondfireCount ?? 0,
    responseCount: currentUser.responseCount ?? 0,
    totalViews: currentUser.totalViews ?? 0,
  }

  return (
    <Container safe>
      <YStack flex={1} paddingHorizontal="$4">
        <XStack justifyContent="space-between" alignItems="center" paddingTop="$4">
          <H1>Profile</H1>
          <Button variant="ghost" size="sm" onPress={handleLogout}>
            <LogOut size={20} color="$gray11" />
          </Button>
        </XStack>

        {/* Profile header */}
        <Card elevated marginTop="$4" padding="$4">
          <XStack gap="$4" alignItems="center">
            <Avatar circular size="$8">
              {currentUser.photoUrl ? (
                <Avatar.Image source={{ uri: currentUser.photoUrl }} />
              ) : (
                <Avatar.Fallback backgroundColor="$orange10">
                  <Text color="$white" fontSize="$6" fontWeight="bold">
                    {(currentUser.displayName ?? currentUser.name ?? 'U')[0].toUpperCase()}
                  </Text>
                </Avatar.Fallback>
              )}
            </Avatar>

            <YStack flex={1}>
              <Text fontWeight="bold" fontSize="$5">
                {currentUser.displayName ?? currentUser.name ?? 'User'}
              </Text>
              <Text color="$gray11" fontSize="$2">
                {currentUser.email}
              </Text>
            </YStack>

            <Button variant="outline" size="sm" onPress={handleEditProfile}>
              <Edit3 size={16} />
            </Button>
          </XStack>
        </Card>

        {/* Stats */}
        <Card marginTop="$4">
          <XStack justifyContent="space-around" paddingVertical="$3">
            <YStack alignItems="center">
              <Text fontSize="$7" fontWeight="bold" color="$orange10">
                {stats.bondfireCount}
              </Text>
              <Text color="$gray11" fontSize="$2">
                Bondfires
              </Text>
            </YStack>
            <Separator vertical />
            <YStack alignItems="center">
              <Text fontSize="$7" fontWeight="bold" color="$orange10">
                {stats.responseCount}
              </Text>
              <Text color="$gray11" fontSize="$2">
                Responses
              </Text>
            </YStack>
            <Separator vertical />
            <YStack alignItems="center">
              <Text fontSize="$7" fontWeight="bold" color="$orange10">
                {stats.totalViews}
              </Text>
              <Text color="$gray11" fontSize="$2">
                Views
              </Text>
            </YStack>
          </XStack>
        </Card>

        {/* Settings */}
        <YStack gap="$3" marginTop="$6">
          <XStack alignItems="center" gap="$2">
            <Settings size={18} color="$gray11" />
            <Text variant="label" color="$gray11">
              Settings
            </Text>
          </XStack>

          <Card>
            <YStack gap="$3">
              <XStack justifyContent="space-between" alignItems="center">
                <YStack>
                  <Text fontWeight="500">Video Quality</Text>
                  <Text fontSize="$2" color="$gray11">
                    Auto adjusts based on network
                  </Text>
                </YStack>
                <Text color="$orange10" fontWeight="500">
                  {preferences.videoQuality.toUpperCase()}
                </Text>
              </XStack>

              <Separator />

              <XStack justifyContent="space-between" alignItems="center">
                <YStack>
                  <Text fontWeight="500">Autoplay Videos</Text>
                  <Text fontSize="$2" color="$gray11">
                    Play videos automatically in feed
                  </Text>
                </YStack>
                <Switch checked={preferences.autoplayVideos} onCheckedChange={setAutoplayVideos}>
                  <Switch.Thumb animation="quick" />
                </Switch>
              </XStack>

              <Separator />

              <XStack justifyContent="space-between" alignItems="center">
                <YStack>
                  <Text fontWeight="500">Notifications</Text>
                  <Text fontSize="$2" color="$gray11">
                    Get notified of new responses
                  </Text>
                </YStack>
                <Switch
                  checked={preferences.notificationsEnabled}
                  onCheckedChange={setNotificationsEnabled}
                >
                  <Switch.Thumb animation="quick" />
                </Switch>
              </XStack>
            </YStack>
          </Card>
        </YStack>

        {/* User's Bondfires */}
        {userBondfires && userBondfires.length > 0 && (
          <YStack gap="$3" marginTop="$6" flex={1}>
            <Text variant="label" color="$gray11">
              Your Bondfires
            </Text>

            <FlatList
              data={userBondfires}
              keyExtractor={(item) => item._id}
              horizontal
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => (
                <Card
                  width={150}
                  height={200}
                  marginRight="$3"
                  padding={0}
                  overflow="hidden"
                  interactive
                  onPress={() => router.push(`/(main)/bondfire/${item._id}`)}
                >
                  <YStack
                    flex={1}
                    backgroundColor="$gray3"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Text fontSize={40}>🔥</Text>
                  </YStack>
                  <YStack padding="$2">
                    <Text fontSize="$2" numberOfLines={1}>
                      {item.videoCount} videos
                    </Text>
                    <Text fontSize="$1" color="$gray11">
                      {item.viewCount ?? 0} views
                    </Text>
                  </YStack>
                </Card>
              )}
            />
          </YStack>
        )}
      </YStack>

      {/* Edit Profile Sheet */}
      <Sheet
        open={isEditSheetOpen}
        onOpenChange={setIsEditSheetOpen}
        snapPoints={[40]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay />
        <Sheet.Frame padding="$4">
          <Sheet.Handle />
          <YStack gap="$4" marginTop="$4">
            <Text fontSize="$5" fontWeight="bold">
              Edit Profile
            </Text>

            <YStack gap="$2">
              <Text variant="label">Display Name</Text>
              <Input value={editName} onChangeText={setEditName} placeholder="Your name" />
            </YStack>

            <XStack gap="$3">
              <Button variant="outline" flex={1} onPress={() => setIsEditSheetOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" flex={1} onPress={handleSaveProfile} disabled={isSaving}>
                {isSaving ? <Spinner size="small" /> : 'Save'}
              </Button>
            </XStack>
          </YStack>
        </Sheet.Frame>
      </Sheet>
    </Container>
  )
}
