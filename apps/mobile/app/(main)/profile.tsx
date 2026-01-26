import { appActions, usePreferences } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Card, Input, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useAuthActions } from '@convex-dev/auth/react'
import {
  Bell,
  Edit3,
  Eye,
  Flame,
  LogOut,
  MessageCircle,
  Play,
  Settings,
  Trash2,
  User,
  Video,
} from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import { Alert, FlatList, Pressable, ScrollView, StatusBar } from 'react-native'
import { Avatar, Separator, Sheet, Spinner, Switch, XStack, YStack } from 'tamagui'
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
  const deleteAccountMutation = useMutation(api.users.deleteAccount)

  const { preferences, setVideoQuality, setAutoplayVideos, setNotificationsEnabled } =
    usePreferences()

  const state$ = useObservable({
    isEditSheetOpen: false,
    isVideoQualitySheetOpen: false,
    editName: '',
    isSaving: false,
    isDeleting: false,
  })

  const isEditSheetOpen = useValue(state$.isEditSheetOpen)
  const isVideoQualitySheetOpen = useValue(state$.isVideoQualitySheetOpen)
  const editName = useValue(state$.editName)
  const isSaving = useValue(state$.isSaving)
  const isDeleting = useValue(state$.isDeleting)

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
    state$.editName.set(currentUser?.displayName ?? currentUser?.name ?? '')
    state$.isEditSheetOpen.set(true)
  }, [currentUser, state$])

  const handleSaveProfile = useCallback(async () => {
    state$.isSaving.set(true)
    try {
      await updateProfile({
        displayName: state$.editName.get(),
      })
      state$.isEditSheetOpen.set(false)
    } catch {
      Alert.alert('Error', 'Failed to update profile')
    } finally {
      state$.isSaving.set(false)
    }
  }, [updateProfile, state$])

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to permanently delete your account? This will delete all your bondfires, videos, and data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => {
            // Second confirmation for such a destructive action
            Alert.alert(
              'Final Confirmation',
              'This is permanent. All your data will be deleted forever.',
              [
                { text: 'Keep My Account', style: 'cancel' },
                {
                  text: 'Yes, Delete Everything',
                  style: 'destructive',
                  onPress: async () => {
                    state$.isDeleting.set(true)
                    try {
                      await deleteAccountMutation()
                      await signOut()
                      appActions.logout()
                      router.replace('/(auth)/login')
                    } catch {
                      Alert.alert('Error', 'Failed to delete account. Please try again.')
                      state$.isDeleting.set(false)
                    }
                  },
                },
              ],
            )
          },
        },
      ],
    )
  }, [deleteAccountMutation, signOut, router, state$])

  if (!currentUser) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
      >
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
      </YStack>
    )
  }

  const stats = {
    bondfireCount: currentUser.bondfireCount ?? 0,
    responseCount: currentUser.responseCount ?? 0,
    totalViews: currentUser.totalViews ?? 0,
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      {/* Header */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        paddingTop={60}
        paddingHorizontal={20}
        paddingBottom={16}
      >
        <Text fontSize={28} fontWeight="700">
          Profile
        </Text>
        <Pressable onPress={handleLogout}>
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
          >
            <LogOut size={20} color={bondfireColors.ash} />
          </YStack>
        </Pressable>
      </XStack>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        showsVerticalScrollIndicator={false}
      >
        <YStack gap={0} paddingBottom={20}>
          {/* Profile header card */}
          <Card elevated marginBottom={20}>
            <XStack gap={16} alignItems="center">
              <Avatar circular size="$8">
                {currentUser.photoUrl ? (
                  <Avatar.Image source={{ uri: currentUser.photoUrl }} />
                ) : (
                  <Avatar.Fallback
                    backgroundColor={bondfireColors.gunmetal}
                    borderWidth={2}
                    borderRadius={100}
                    borderColor={bondfireColors.bondfireCopper}
                    alignItems="center"
                    justifyContent="center"
                  >
                    <User size={32} color={bondfireColors.bondfireCopper} />
                  </Avatar.Fallback>
                )}
              </Avatar>

              <YStack flex={1}>
                <Text fontWeight="700" fontSize={18}>
                  {currentUser.displayName ?? currentUser.name ?? 'User'}
                </Text>
                <Text color={bondfireColors.ash} fontSize={14}>
                  {currentUser.email}
                </Text>
              </YStack>

              <Pressable onPress={handleEditProfile}>
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={bondfireColors.iron}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Edit3 size={18} color={bondfireColors.whiteSmoke} />
                </YStack>
              </Pressable>
            </XStack>
          </Card>

          {/* Stats */}
          <Card marginBottom={24}>
            <XStack justifyContent="space-around" paddingVertical={8}>
              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <Flame size={20} color={bondfireColors.bondfireCopper} />
                  <Text fontSize={24} fontWeight="700" color={bondfireColors.bondfireCopper}>
                    {stats.bondfireCount}
                  </Text>
                </XStack>
                <Text color={bondfireColors.ash} fontSize={12}>
                  Bondfires
                </Text>
              </YStack>

              <Separator vertical borderColor={bondfireColors.iron} />

              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <MessageCircle size={20} color={bondfireColors.moltenGold} />
                  <Text fontSize={24} fontWeight="700" color={bondfireColors.moltenGold}>
                    {stats.responseCount}
                  </Text>
                </XStack>
                <Text color={bondfireColors.ash} fontSize={12}>
                  Responses
                </Text>
              </YStack>

              <Separator vertical borderColor={bondfireColors.iron} />

              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <Eye size={20} color={bondfireColors.whiteSmoke} />
                  <Text fontSize={24} fontWeight="700" color={bondfireColors.whiteSmoke}>
                    {stats.totalViews}
                  </Text>
                </XStack>
                <Text color={bondfireColors.ash} fontSize={12}>
                  Views
                </Text>
              </YStack>
            </XStack>
          </Card>

          {/* Settings */}
          <YStack gap={12} marginBottom={24}>
            <XStack alignItems="center" gap={8}>
              <Settings size={18} color={bondfireColors.ash} />
              <Text variant="label" color={bondfireColors.ash} fontSize={13} fontWeight="600">
                SETTINGS
              </Text>
            </XStack>

            <Card>
              <YStack gap={16}>
                <Pressable onPress={() => state$.isVideoQualitySheetOpen.set(true)}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <XStack alignItems="center" gap={12}>
                      <Video size={20} color={bondfireColors.bondfireCopper} />
                      <YStack>
                        <Text fontWeight="500" fontSize={15}>
                          Video Quality
                        </Text>
                        <Text fontSize={13} color={bondfireColors.ash}>
                          Tap to change quality preference
                        </Text>
                      </YStack>
                    </XStack>
                    <Text color={bondfireColors.bondfireCopper} fontWeight="600" fontSize={14}>
                      {preferences.videoQuality.toUpperCase()}
                    </Text>
                  </XStack>
                </Pressable>

                <Separator borderColor={bondfireColors.iron} />

                <XStack justifyContent="space-between" alignItems="center">
                  <XStack alignItems="center" gap={12}>
                    <Play size={20} color={bondfireColors.moltenGold} />
                    <YStack>
                      <Text fontWeight="500" fontSize={15}>
                        Autoplay Videos
                      </Text>
                      <Text fontSize={13} color={bondfireColors.ash}>
                        Play videos automatically in feed
                      </Text>
                    </YStack>
                  </XStack>
                  <Switch
                    checked={preferences.autoplayVideos}
                    onCheckedChange={setAutoplayVideos}
                    backgroundColor={bondfireColors.iron}
                  >
                    <Switch.Thumb
                      animation="quick"
                      backgroundColor={
                        preferences.autoplayVideos
                          ? bondfireColors.bondfireCopper
                          : bondfireColors.ash
                      }
                    />
                  </Switch>
                </XStack>

                <Separator borderColor={bondfireColors.iron} />

                <XStack justifyContent="space-between" alignItems="center">
                  <XStack alignItems="center" gap={12}>
                    <Bell size={20} color={bondfireColors.deepEmber} />
                    <YStack>
                      <Text fontWeight="500" fontSize={15}>
                        Notifications
                      </Text>
                      <Text fontSize={13} color={bondfireColors.ash}>
                        Get notified of new responses
                      </Text>
                    </YStack>
                  </XStack>
                  <Switch
                    checked={preferences.notificationsEnabled}
                    onCheckedChange={setNotificationsEnabled}
                    backgroundColor={bondfireColors.iron}
                  >
                    <Switch.Thumb
                      animation="quick"
                      backgroundColor={
                        preferences.notificationsEnabled
                          ? bondfireColors.bondfireCopper
                          : bondfireColors.ash
                      }
                    />
                  </Switch>
                </XStack>
              </YStack>
            </Card>
          </YStack>

          {/* User's Bondfires */}
          {userBondfires && userBondfires.length > 0 && (
            <YStack gap={12} marginBottom={24}>
              <XStack alignItems="center" gap={8}>
                <Flame size={18} color={bondfireColors.ash} />
                <Text variant="label" color={bondfireColors.ash} fontSize={13} fontWeight="600">
                  YOUR BONDFIRES
                </Text>
              </XStack>

              <FlatList
                data={userBondfires}
                keyExtractor={(item) => item._id}
                horizontal
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => (
                  <Pressable onPress={() => router.push(`/(main)/bondfire/${item._id}`)}>
                    <Card
                      width={140}
                      height={180}
                      marginRight={12}
                      padding={0}
                      overflow="hidden"
                      interactive
                    >
                      <YStack
                        flex={1}
                        backgroundColor={bondfireColors.charcoal}
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Flame size={40} color={bondfireColors.bondfireCopper} />
                      </YStack>
                      <YStack padding={12} gap={4} backgroundColor={bondfireColors.gunmetal}>
                        <XStack alignItems="center" gap={6}>
                          <MessageCircle size={14} color={bondfireColors.ash} />
                          <Text fontSize={13} color={bondfireColors.whiteSmoke}>
                            {item.videoCount} videos
                          </Text>
                        </XStack>
                        <XStack alignItems="center" gap={6}>
                          <Eye size={14} color={bondfireColors.ash} />
                          <Text fontSize={12} color={bondfireColors.ash}>
                            {item.viewCount ?? 0} views
                          </Text>
                        </XStack>
                      </YStack>
                    </Card>
                  </Pressable>
                )}
              />
            </YStack>
          )}

          {/* Danger Zone */}
          <YStack gap={12} marginBottom={24}>
            <XStack alignItems="center" gap={8}>
              <Trash2 size={18} color={bondfireColors.error} />
              <Text variant="label" color={bondfireColors.error} fontSize={13} fontWeight="600">
                DANGER ZONE
              </Text>
            </XStack>

            <Card borderColor={bondfireColors.error} borderWidth={1}>
              <YStack gap={12}>
                <YStack gap={4}>
                  <Text fontWeight="500" fontSize={15}>
                    Delete Account
                  </Text>
                  <Text fontSize={13} color={bondfireColors.ash}>
                    Permanently delete your account and all associated data. This action cannot be
                    undone.
                  </Text>
                </YStack>
                <Button
                  variant="outline"
                  size="$sm"
                  onPress={handleDeleteAccount}
                  disabled={isDeleting}
                  borderColor={bondfireColors.error}
                >
                  {isDeleting ? (
                    <Spinner size="small" color={bondfireColors.error} />
                  ) : (
                    <>
                      <Trash2 size={16} color={bondfireColors.error} />
                      <Text color={bondfireColors.error}>Delete My Account</Text>
                    </>
                  )}
                </Button>
              </YStack>
            </Card>
          </YStack>
        </YStack>
      </ScrollView>

      {/* Edit Profile Sheet */}
      <Sheet
        open={isEditSheetOpen}
        onOpenChange={(open: boolean) => state$.isEditSheetOpen.set(open)}
        snapPoints={[40]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.6)" />
        <Sheet.Frame
          padding={20}
          backgroundColor={bondfireColors.gunmetal}
          borderTopLeftRadius={24}
          borderTopRightRadius={24}
        >
          <Sheet.Handle backgroundColor={bondfireColors.iron} />
          <YStack gap={20} marginTop={16}>
            <Text fontSize={20} fontWeight="700">
              Edit Profile
            </Text>

            <YStack gap={8}>
              <Text variant="label" color={bondfireColors.whiteSmoke}>
                Display Name
              </Text>
              <Input value={editName} onChangeText={(text) => state$.editName.set(text)} placeholder="Your name" />
            </YStack>

            <XStack gap={12}>
              <Button
                variant="outline"
                flex={1}
                size="$md"
                onPress={() => state$.isEditSheetOpen.set(false)}
              >
                <Text color={bondfireColors.whiteSmoke}>Cancel</Text>
              </Button>
              <Button
                variant="primary"
                flex={1}
                size="$md"
                onPress={handleSaveProfile}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Spinner size="small" color={bondfireColors.whiteSmoke} />
                ) : (
                  <Text color={bondfireColors.whiteSmoke}>Save</Text>
                )}
              </Button>
            </XStack>
          </YStack>
        </Sheet.Frame>
      </Sheet>

      {/* Video Quality Sheet */}
      <Sheet
        open={isVideoQualitySheetOpen}
        onOpenChange={(open: boolean) => state$.isVideoQualitySheetOpen.set(open)}
        snapPoints={[35]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.6)" />
        <Sheet.Frame
          padding={20}
          backgroundColor={bondfireColors.gunmetal}
          borderTopLeftRadius={24}
          borderTopRightRadius={24}
        >
          <Sheet.Handle backgroundColor={bondfireColors.iron} />
          <YStack gap={20} marginTop={16}>
            <Text fontSize={20} fontWeight="700">
              Video Quality
            </Text>

            <YStack gap={12}>
              {(['auto', 'hd', 'sd'] as const).map((quality) => (
                <Pressable
                  key={quality}
                  onPress={() => {
                    setVideoQuality(quality)
                    state$.isVideoQualitySheetOpen.set(false)
                  }}
                >
                  <XStack
                    padding={16}
                    borderRadius={12}
                    backgroundColor={
                      preferences.videoQuality === quality
                        ? bondfireColors.charcoal
                        : bondfireColors.iron
                    }
                    borderWidth={preferences.videoQuality === quality ? 2 : 0}
                    borderColor={bondfireColors.bondfireCopper}
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <YStack>
                      <Text fontWeight="600" fontSize={16}>
                        {quality === 'auto' ? 'Auto' : quality === 'hd' ? 'High (HD)' : 'Standard (SD)'}
                      </Text>
                      <Text fontSize={13} color={bondfireColors.ash}>
                        {quality === 'auto'
                          ? 'Adjusts based on network speed'
                          : quality === 'hd'
                            ? 'Best quality, uses more data'
                            : 'Lower quality, saves data'}
                      </Text>
                    </YStack>
                    {preferences.videoQuality === quality && (
                      <Video size={20} color={bondfireColors.bondfireCopper} />
                    )}
                  </XStack>
                </Pressable>
              ))}
            </YStack>
          </YStack>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  )
}
