import {
  appActions,
  getBondfireVideoIndex,
  parseError,
  requestPushPermission,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  telemetry,
  uploadQueueActions,
  useAppTheme,
  useAppThemeColors,
  useKindlingBalance,
  usePreferences,
  useSubscription,
} from '@bondfires/app'
import { AdminPanel, Button, Card, Input, Spinner, SubscriptionStatus, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useObservable, useValue } from '@legendapp/state/react'
import {
  Bell,
  Camera,
  Edit3,
  Eye,
  Flame,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  Pin,
  Play,
  Settings,
  Sun,
  Trash2,
  User,
  Video,
} from '@tamagui/lucide-icons'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StatusBar } from 'react-native'
import { Avatar, Separator, Sheet, Switch, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { NotificationPreferencesSection } from '../../../components/NotificationPreferencesSection'
import { UploadProgressCard } from '../../../components/UploadProgressCard'
import { routes } from '../../../lib/routes'

type UserBondfireData = Doc<'bondfires'>
type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}
type CloseCircleEntry = {
  user: PublicUser
  primaryThread: (Doc<'bondfires'> & { lastActivityAt: number }) | null
  sharedThreads: Array<Doc<'bondfires'> & { lastActivityAt: number }>
  privateCampThreads: Array<Doc<'bondfires'> & { lastActivityAt: number }>
}
type Gender = 'male' | 'female' | 'other'
type CurrentUserData = {
  _id: Id<'users'>
  email?: string
  emailVerified?: boolean
  name?: string
  displayName?: string
  photoUrl?: string
  gender: Gender
  age?: number
  bondfireCount: number
  responseCount: number
  totalViews: number
  isAdmin?: boolean
} | null

const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
]

function ProfileSubscription({
  onResolved,
}: {
  onResolved: (params: {
    currentUser: CurrentUserData
    userBondfires: UserBondfireData[] | undefined
  }) => void
}) {
  const currentUser = useQuery(api.users.current)
  const userBondfires = useQuery(
    api.bondfires.listByUser,
    currentUser?._id ? { userId: currentUser._id } : 'skip',
  )

  useEffect(() => {
    if (currentUser === undefined) return
    if (currentUser?._id && userBondfires === undefined) return

    onResolved({
      currentUser,
      userBondfires: currentUser?._id ? (userBondfires ?? []) : undefined,
    })
  }, [currentUser, onResolved, userBondfires])

  return null
}

function ThemeSelector() {
  const { themePreference, setThemePreference, isLoading, isSaving } = useAppTheme()

  const options: Array<{
    value: 'system' | 'light' | 'dark'
    label: string
    Icon: typeof Monitor
  }> = [
    { value: 'system', label: 'System', Icon: Monitor },
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
  ]

  const handleSelectTheme = useCallback(
    async (value: 'system' | 'light' | 'dark') => {
      try {
        await setThemePreference(value)
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Error', message)
      }
    },
    [setThemePreference],
  )

  if (isLoading) return null

  return (
    <YStack gap={12}>
      <XStack alignItems="center" gap={12}>
        <Monitor size={20} color={'$primary'} />
        <YStack>
          <Text fontWeight="500" fontSize={15}>
            Theme
          </Text>
          <Text fontSize={13} color={'$placeholderColor'}>
            Current:{' '}
            {themePreference === 'system'
              ? 'System default'
              : themePreference.charAt(0).toUpperCase() + themePreference.slice(1)}
          </Text>
        </YStack>
      </XStack>

      <XStack gap={8}>
        {options.map((opt) => {
          const { Icon, value, label } = opt
          const isSelected = themePreference === value
          return (
            <Button
              key={value}
              flex={1}
              variant={isSelected ? 'primary' : 'outline'}
              size="$sm"
              disabled={isSaving}
              onPress={() => handleSelectTheme(value)}
            >
              <XStack alignItems="center" justifyContent="center" gap={6}>
                <Icon size={16} color={isSelected ? '$color' : '$placeholderColor'} />
                <Text
                  color={isSelected ? '$color' : '$placeholderColor'}
                  fontWeight={isSelected ? '700' : '500'}
                  fontSize={13}
                >
                  {label}
                </Text>
              </XStack>
            </Button>
          )
        })}
      </XStack>
    </YStack>
  )
}

export default function ProfileScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const { signOut } = useAuthActions()
  const convex = useConvex()

  const updateProfile = useMutation(api.users.updateProfile)
  const generateProfilePhotoUploadUrl = useMutation(api.users.generateProfilePhotoUploadUrl)
  const updateProfilePhoto = useMutation(api.users.updateProfilePhoto)
  const deleteAccountMutation = useMutation(api.users.deleteAccount)
  const adminSetForcedTier = useMutation(api.admin.adminSetForcedTier)
  const closeCircle = useQuery(api.conversations.listCloseCircle) as CloseCircleEntry[] | undefined

  const {
    preferences,
    setVideoQuality,
    setAutoplayVideos,
    setNotificationsEnabled,
    setLivePublishEnabled,
  } = usePreferences()

  const { currentTier, isRestoring, managePlan, restore, showPaywall } = useSubscription()
  const { balance: kindlingBalance, isLoading: kindlingBalanceLoading } = useKindlingBalance()

  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [currentUser, setCurrentUser] = useState<CurrentUserData | undefined>(undefined)
  const [userBondfires, setUserBondfires] = useState<UserBondfireData[] | undefined>(undefined)
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const state$ = useObservable({
    isEditSheetOpen: false,
    isVideoQualitySheetOpen: false,
    editName: '',
    editGender: null as Gender | null,
    isSaving: false,
    isDeleting: false,
    isUploadingPhoto: false,
    devSettingsVisible: false,
    devLongPressCount: 0,
  })

  const devSettingsVisible = useValue(state$.devSettingsVisible)

  const isEditSheetOpen = useValue(state$.isEditSheetOpen)
  const isVideoQualitySheetOpen = useValue(state$.isVideoQualitySheetOpen)
  const editName = useValue(state$.editName)
  const editGender = useValue(state$.editGender)
  const isSaving = useValue(state$.isSaving)
  const isDeleting = useValue(state$.isDeleting)
  const isUploadingPhoto = useValue(state$.isUploadingPhoto)

  const stopRefreshing = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
      refreshTimeoutRef.current = null
    }
    setIsRefreshing(false)
  }, [])

  const handleRefresh = useCallback(() => {
    uploadQueueActions.cleanupForRefresh()
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
    }
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null
      setIsRefreshing(false)
    }, 5000)
  }, [])

  const handleProfileResolved = useCallback(
    ({
      currentUser: nextCurrentUser,
      userBondfires: nextUserBondfires,
    }: {
      currentUser: CurrentUserData
      userBondfires: UserBondfireData[] | undefined
    }) => {
      // Guard against null — the session may have expired while the query was in flight
      if (nextCurrentUser === null) {
        telemetry.warn('auth:session', 'Profile resolved with null user — session may have expired')
        stopRefreshing()
        return
      }
      setCurrentUser(nextCurrentUser)
      setUserBondfires(nextUserBondfires)
      stopRefreshing()
    },
    [stopRefreshing],
  )

  const handleLogout = useCallback(async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut()
          appActions.logout()
          router.replace(routes.login())
        },
      },
    ])
  }, [signOut, router])

  type AdminSearchResult = {
    _id: string
    email?: string
    name?: string
    forcedTier: 'free' | 'plus' | 'premium' | 'pro' | null
  }

  const handleAdminSearch = useCallback(
    async (emailQuery: string): Promise<AdminSearchResult[]> => {
      const result = await convex.query(api.admin.adminSearchUsers, { emailQuery })
      return result.users as AdminSearchResult[]
    },
    [convex],
  )

  const handleAdminSetTier = useCallback(
    async (
      email: string,
      tier: 'free' | 'plus' | 'premium' | 'pro' | null,
    ): Promise<AdminSearchResult | null> => {
      const result = await adminSetForcedTier({ email, tier })
      return result as AdminSearchResult | null
    },
    [adminSetForcedTier],
  )

  const handleEditProfile = useCallback(() => {
    state$.editName.set(currentUser?.displayName ?? currentUser?.name ?? '')
    state$.editGender.set(currentUser?.gender ?? null)
    state$.isEditSheetOpen.set(true)
  }, [currentUser, state$])

  const handleSaveProfile = useCallback(async () => {
    state$.isSaving.set(true)
    try {
      await updateProfile({
        displayName: state$.editName.get(),
        gender: state$.editGender.get() ?? undefined,
      })
      state$.isEditSheetOpen.set(false)
      handleRefresh()
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Error', message)
    } finally {
      state$.isSaving.set(false)
    }
  }, [handleRefresh, state$, updateProfile])

  const handleOpenBondfire = useCallback(
    (bondfireId: string) => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      appActions.setVideoMuted(false)
      router.push(routes.bondfire(bondfireId))
    },
    [router],
  )

  const handleOpenCloseCircle = useCallback(
    (entry: CloseCircleEntry) => {
      if (!entry.primaryThread) {
        Alert.alert('No Shared Fires', 'Shared threads with this person will appear here.')
        return
      }

      handleOpenBondfire(entry.primaryThread._id)
    },
    [handleOpenBondfire],
  )

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
                      router.replace(routes.login())
                    } catch (error) {
                      const message = parseError(error).message
                      Alert.alert('Error', message)
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
  }, [deleteAccountMutation, router, signOut, state$])

  const handleChangePhoto = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    })

    if (result.canceled || !result.assets[0]) return

    state$.isUploadingPhoto.set(true)
    try {
      const manipulated = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 400, height: 400 } }],
        { compress: 0.8, format: SaveFormat.JPEG },
      )

      const uploadUrl = await generateProfilePhotoUploadUrl()

      const response = await fetch(manipulated.uri)
      const blob = await response.blob()
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      })

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.status}`)
      }

      const { storageId } = (await uploadResponse.json()) as { storageId: Id<'_storage'> }
      await updateProfilePhoto({ storageId })
      handleRefresh()
    } catch (error) {
      telemetry.error('profile:upload', 'Photo upload error', { error: String(error) })
      const message = parseError(error).message
      Alert.alert('Error', message)
    } finally {
      state$.isUploadingPhoto.set(false)
    }
  }, [generateProfilePhotoUploadUrl, handleRefresh, state$, updateProfilePhoto])

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current)
        refreshTimeoutRef.current = null
      }
    }
  }, [])

  if (!currentUser) {
    return (
      <YStack flex={1}>
        <ProfileSubscription key={refreshKey} onResolved={handleProfileResolved} />
        <YStack
          flex={1}
          backgroundColor={'$background'}
          alignItems="center"
          justifyContent="center"
        >
          <Spinner size="large" color={'$primary'} />
        </YStack>
      </YStack>
    )
  }

  const stats = {
    bondfireCount: currentUser.bondfireCount ?? 0,
    responseCount: currentUser.responseCount ?? 0,
    totalViews: currentUser.totalViews ?? 0,
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <ProfileSubscription key={refreshKey} onResolved={handleProfileResolved} />
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

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
            backgroundColor={'$backgroundHover'}
            alignItems="center"
            justifyContent="center"
          >
            <LogOut size={20} color={'$placeholderColor'} />
          </YStack>
        </Pressable>
      </XStack>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <YStack gap={0} paddingBottom={20}>
          <Card elevated marginBottom={20}>
            <XStack gap={16} alignItems="center">
              <Pressable onPress={handleChangePhoto} disabled={isUploadingPhoto}>
                <Avatar circular size="$8">
                  {currentUser.photoUrl ? (
                    <Avatar.Image source={{ uri: currentUser.photoUrl }} />
                  ) : (
                    <Avatar.Fallback
                      backgroundColor={'$backgroundHover'}
                      borderWidth={2}
                      borderRadius={100}
                      borderColor={'$primary'}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <User size={32} color={'$primary'} />
                    </Avatar.Fallback>
                  )}
                </Avatar>
                <YStack
                  position="absolute"
                  bottom={0}
                  right={0}
                  width={28}
                  height={28}
                  borderRadius={14}
                  backgroundColor={'$primary'}
                  alignItems="center"
                  justifyContent="center"
                  borderWidth={2}
                  borderColor={'$background'}
                >
                  {isUploadingPhoto ? (
                    <Spinner size="small" color={'$color'} />
                  ) : (
                    <Camera size={14} color={'$color'} />
                  )}
                </YStack>
              </Pressable>

              <YStack flex={1}>
                <Text fontWeight="700" fontSize={18}>
                  {currentUser.displayName ?? currentUser.name ?? 'User'}
                </Text>
                <Text color={'$placeholderColor'} fontSize={14}>
                  {currentUser.email}
                </Text>
                <Text color={'$placeholderColor'} fontSize={12} textTransform="capitalize">
                  {currentUser.gender ?? 'Gender not set'}
                </Text>
              </YStack>

              <Pressable onPress={handleEditProfile}>
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={'$borderColor'}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Edit3 size={18} color={'$color'} />
                </YStack>
              </Pressable>
            </XStack>
          </Card>

          <Card marginBottom={24}>
            <XStack justifyContent="space-around" paddingVertical={8}>
              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <Flame size={20} color={'$primary'} />
                  <Text fontSize={24} fontWeight="700" color={'$primary'}>
                    {stats.bondfireCount}
                  </Text>
                </XStack>
                <Text color={'$placeholderColor'} fontSize={12}>
                  Bondfires
                </Text>
              </YStack>

              <Separator vertical borderColor={'$borderColor'} />

              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <MessageCircle size={20} color={'$secondary'} />
                  <Text fontSize={24} fontWeight="700" color={'$secondary'}>
                    {stats.responseCount}
                  </Text>
                </XStack>
                <Text color={'$placeholderColor'} fontSize={12}>
                  Responses
                </Text>
              </YStack>

              <Separator vertical borderColor={'$borderColor'} />

              <YStack alignItems="center" gap={4}>
                <XStack alignItems="center" gap={6}>
                  <Eye size={20} color={'$color'} />
                  <Text fontSize={24} fontWeight="700" color={'$color'}>
                    {stats.totalViews}
                  </Text>
                </XStack>
                <Text color={'$placeholderColor'} fontSize={12}>
                  Views
                </Text>
              </YStack>
            </XStack>
          </Card>

          <UploadProgressCard />

          {/* Camp Kindling Balance */}
          {!kindlingBalanceLoading && currentTier === 'pro' ? (
            <Card marginBottom={24}>
              <XStack alignItems="center" justifyContent="space-between" padding={16}>
                <YStack gap={4}>
                  <Text fontSize={15} fontWeight="600">
                    Camp Kindling
                  </Text>
                  <Text fontSize={13} color={'$placeholderColor'}>
                    {kindlingBalance > 0
                      ? `${kindlingBalance} kindling available`
                      : 'No kindling available'}
                  </Text>
                </YStack>
                {kindlingBalance < 3 && (
                  <Button variant="primary" size="$sm" onPress={showPaywall}>
                    <Text color={'$color'} fontWeight="600" fontSize={13}>
                      Get More
                    </Text>
                  </Button>
                )}
              </XStack>
            </Card>
          ) : null}

          {/* Subscription Status */}
          <YStack marginBottom={24}>
            <SubscriptionStatus
              currentTier={currentTier}
              isRestoring={isRestoring}
              onManagePress={currentTier === 'free' ? showPaywall : managePlan}
              onRestorePress={restore}
            />
          </YStack>

          {/* Admin Panel — only visible to admin users */}
          {currentUser.isAdmin && (
            <AdminPanel
              isAdmin={currentUser.isAdmin}
              onSearch={handleAdminSearch}
              onSetTier={handleAdminSetTier}
            />
          )}

          {closeCircle && closeCircle.length > 0 && (
            <YStack gap={12} marginBottom={24}>
              <XStack alignItems="center" gap={8}>
                <Pin size={18} color={'$placeholderColor'} />
                <Text variant="label" color={'$placeholderColor'} fontSize={13} fontWeight="600">
                  CLOSE CIRCLE
                </Text>
              </XStack>

              <FlatList
                data={closeCircle}
                keyExtractor={(item) => item.user._id}
                horizontal
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => {
                  const sharedCount = item.sharedThreads.length
                  const privateCount = item.privateCampThreads.length
                  return (
                    <Card
                      width={156}
                      minHeight={170}
                      marginRight={12}
                      interactive
                      accessibilityRole="button"
                      accessibilityLabel="Open close circle fires"
                      onPress={() => handleOpenCloseCircle(item)}
                    >
                      <YStack alignItems="center" gap={10}>
                        <Avatar circular size="$6">
                          {item.user.photoUrl ? (
                            <Avatar.Image source={{ uri: item.user.photoUrl }} />
                          ) : (
                            <Avatar.Fallback
                              backgroundColor={'$backgroundHover'}
                              borderWidth={1}
                              borderColor={'$primary'}
                            >
                              <User size={24} color={'$primary'} />
                            </Avatar.Fallback>
                          )}
                        </Avatar>
                        <Text fontSize={15} fontWeight="900" numberOfLines={1} textAlign="center">
                          {item.user.displayName ?? item.user.name ?? 'Someone'}
                        </Text>
                        <YStack gap={4} alignItems="center">
                          <Text fontSize={12} color={'$placeholderColor'}>
                            {sharedCount} shared
                          </Text>
                          <Text fontSize={12} color={'$placeholderColor'}>
                            {privateCount} private camp
                          </Text>
                        </YStack>
                      </YStack>
                    </Card>
                  )
                }}
              />
            </YStack>
          )}

          <YStack gap={12} marginBottom={24}>
            <Pressable
              onLongPress={() => {
                state$.devSettingsVisible.set(!devSettingsVisible)
              }}
              delayLongPress={800}
            >
              <XStack alignItems="center" gap={8}>
                <Settings size={18} color={'$placeholderColor'} />
                <Text variant="label" color={'$placeholderColor'} fontSize={13} fontWeight="600">
                  SETTINGS
                </Text>
              </XStack>
            </Pressable>

            <Card>
              <YStack gap={16}>
                <Pressable onPress={() => state$.isVideoQualitySheetOpen.set(true)}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <XStack alignItems="center" gap={12}>
                      <Video size={20} color={'$primary'} />
                      <YStack>
                        <Text fontWeight="500" fontSize={15}>
                          Video Quality
                        </Text>
                        <Text fontSize={13} color={'$placeholderColor'}>
                          Tap to change quality preference
                        </Text>
                      </YStack>
                    </XStack>
                    <Text color={'$primary'} fontWeight="600" fontSize={14}>
                      {preferences.videoQuality.toUpperCase()}
                    </Text>
                  </XStack>
                </Pressable>

                <Separator borderColor={'$borderColor'} />

                <XStack justifyContent="space-between" alignItems="center">
                  <XStack alignItems="center" gap={12}>
                    <Play size={20} color={'$secondary'} />
                    <YStack>
                      <Text fontWeight="500" fontSize={15}>
                        Autoplay Videos
                      </Text>
                      <Text fontSize={13} color={'$placeholderColor'}>
                        Play videos automatically in feed
                      </Text>
                    </YStack>
                  </XStack>
                  <Switch
                    checked={preferences.autoplayVideos}
                    onCheckedChange={setAutoplayVideos}
                    backgroundColor={'$borderColor'}
                  >
                    <Switch.Thumb
                      animation="quick"
                      backgroundColor={
                        preferences.autoplayVideos ? '$primary' : '$placeholderColor'
                      }
                    />
                  </Switch>
                </XStack>

                <Separator borderColor={'$borderColor'} />

                <XStack justifyContent="space-between" alignItems="center">
                  <XStack alignItems="center" gap={12}>
                    <Bell size={20} color={'$primaryPress'} />
                    <YStack>
                      <Text fontWeight="500" fontSize={15}>
                        Notifications
                      </Text>
                      <Text fontSize={13} color={'$placeholderColor'}>
                        Get notified of new responses
                      </Text>
                    </YStack>
                  </XStack>
                  <Switch
                    checked={preferences.notificationsEnabled}
                    onCheckedChange={(enabled: boolean) => {
                      setNotificationsEnabled(enabled)
                      if (enabled) {
                        // Explicit user intent — OK to fire the OS
                        // permission dialog if it hasn't been asked yet.
                        requestPushPermission()
                      }
                    }}
                    backgroundColor={'$borderColor'}
                  >
                    <Switch.Thumb
                      animation="quick"
                      backgroundColor={
                        preferences.notificationsEnabled ? '$primary' : '$placeholderColor'
                      }
                    />
                  </Switch>
                </XStack>

                {preferences.notificationsEnabled && <NotificationPreferencesSection />}

                <Separator borderColor={'$borderColor'} />

                <ThemeSelector />

                {devSettingsVisible && (
                  <>
                    <Separator borderColor={'$borderColor'} />
                    <XStack alignItems="center" gap={8}>
                      <Flame size={16} color={'$warning'} />
                      <Text variant="label" color={'$warning'} fontSize={11} fontWeight="700">
                        DEV SETTINGS
                      </Text>
                    </XStack>
                    <XStack justifyContent="space-between" alignItems="center">
                      <XStack alignItems="center" gap={12}>
                        <Camera size={20} color={'$warning'} />
                        <YStack>
                          <Text fontWeight="500" fontSize={15}>
                            Live Publisher
                          </Text>
                          <Text fontSize={13} color={'$placeholderColor'}>
                            Native RTMP live streaming (dev only)
                          </Text>
                        </YStack>
                      </XStack>
                      <Switch
                        checked={preferences.livePublishEnabled}
                        onCheckedChange={setLivePublishEnabled}
                        backgroundColor={'$borderColor'}
                      >
                        <Switch.Thumb
                          animation="quick"
                          backgroundColor={
                            preferences.livePublishEnabled ? '$warning' : '$placeholderColor'
                          }
                        />
                      </Switch>
                    </XStack>
                    <Text fontSize={12} color={'$placeholderColor'} fontStyle="italic">
                      Long-press "SETTINGS" header to hide dev options
                    </Text>
                  </>
                )}
              </YStack>
            </Card>
          </YStack>

          {userBondfires && userBondfires.length > 0 && (
            <YStack gap={12} marginBottom={24}>
              <XStack alignItems="center" gap={8}>
                <Flame size={18} color={'$placeholderColor'} />
                <Text variant="label" color={'$placeholderColor'} fontSize={13} fontWeight="600">
                  YOUR BONDFIRES
                </Text>
              </XStack>

              <FlatList
                data={userBondfires}
                keyExtractor={(item) => item._id}
                horizontal
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => (
                  <Card
                    width={140}
                    height={180}
                    marginRight={12}
                    padding={0}
                    overflow="hidden"
                    interactive
                    accessibilityRole="button"
                    accessibilityLabel="Open Bondfire"
                    onPress={() => handleOpenBondfire(item._id)}
                  >
                    <YStack
                      flex={1}
                      backgroundColor={'$backgroundPress'}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Flame size={40} color={'$primary'} />
                    </YStack>
                    <YStack padding={12} gap={4} backgroundColor={'$backgroundHover'}>
                      <XStack alignItems="center" gap={6}>
                        <MessageCircle size={14} color={'$placeholderColor'} />
                        <Text fontSize={13} color={'$color'}>
                          {item.videoCount} videos
                        </Text>
                      </XStack>
                      <XStack alignItems="center" gap={6}>
                        <Eye size={14} color={'$placeholderColor'} />
                        <Text fontSize={12} color={'$placeholderColor'}>
                          {item.viewCount ?? 0} views
                        </Text>
                      </XStack>
                    </YStack>
                  </Card>
                )}
              />
            </YStack>
          )}

          <YStack gap={12} marginBottom={24}>
            <XStack alignItems="center" gap={8}>
              <Trash2 size={18} color={'$error'} />
              <Text variant="label" color={'$error'} fontSize={13} fontWeight="600">
                DANGER ZONE
              </Text>
            </XStack>

            <Card borderColor={'$error'} borderWidth={1}>
              <YStack gap={12}>
                <YStack gap={4}>
                  <Text fontWeight="500" fontSize={15}>
                    Delete Account
                  </Text>
                  <Text fontSize={13} color={'$placeholderColor'}>
                    Permanently delete your account and all associated data. This action cannot be
                    undone.
                  </Text>
                </YStack>
                <Button
                  variant="outline"
                  size="$sm"
                  onPress={handleDeleteAccount}
                  disabled={isDeleting}
                  borderColor={'$error'}
                >
                  {isDeleting ? (
                    <Spinner size="small" color={'$error'} />
                  ) : (
                    <>
                      <Trash2 size={16} color={'$error'} />
                      <Text color={'$error'}>Delete My Account</Text>
                    </>
                  )}
                </Button>
              </YStack>
            </Card>
          </YStack>
        </YStack>
      </ScrollView>

      <Sheet
        open={isEditSheetOpen}
        onOpenChange={(open: boolean) => state$.isEditSheetOpen.set(open)}
        snapPoints={[50]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.6)" />
        <Sheet.Frame
          padding={20}
          backgroundColor={'$backgroundHover'}
          borderTopLeftRadius={24}
          borderTopRightRadius={24}
        >
          <Sheet.Handle backgroundColor={'$borderColor'} />
          <YStack gap={20} marginTop={16}>
            <Text fontSize={20} fontWeight="700">
              Edit Profile
            </Text>

            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Display Name
              </Text>
              <Input
                value={editName}
                onChangeText={(text) => state$.editName.set(text)}
                placeholder="Your name"
              />
            </YStack>

            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Gender
              </Text>
              <XStack gap={8}>
                {GENDER_OPTIONS.map((option) => {
                  const selected = editGender === option.value
                  return (
                    <Button
                      key={option.value}
                      variant={selected ? 'primary' : 'outline'}
                      size="$md"
                      flex={1}
                      onPress={() => state$.editGender.set(option.value)}
                    >
                      <Text color={selected ? '$color' : '$placeholderColor'} fontWeight="900">
                        {option.label}
                      </Text>
                    </Button>
                  )
                })}
              </XStack>
            </YStack>

            <YStack gap={8}>
              <Text variant="label" color={'$color'}>
                Age
              </Text>
              <Text fontSize={12} color={'$placeholderColor'}>
                {currentUser?.age !== undefined ? currentUser.age : 'Not set'}
              </Text>
              <Text fontSize={12} color={'$placeholderColor'}>
                Based on your private birth date. Contact support to request a correction.
              </Text>
            </YStack>

            <XStack gap={12}>
              <Button
                variant="outline"
                flex={1}
                size="$md"
                onPress={() => state$.isEditSheetOpen.set(false)}
              >
                <Text color={'$color'}>Cancel</Text>
              </Button>
              <Button
                variant="primary"
                flex={1}
                size="$md"
                onPress={handleSaveProfile}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Spinner size="small" color={'$color'} />
                ) : (
                  <Text color={'$color'}>Save</Text>
                )}
              </Button>
            </XStack>
          </YStack>
        </Sheet.Frame>
      </Sheet>

      <Sheet
        open={isVideoQualitySheetOpen}
        onOpenChange={(open: boolean) => state$.isVideoQualitySheetOpen.set(open)}
        snapPoints={[35]}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay backgroundColor="rgba(0,0,0,0.6)" />
        <Sheet.Frame
          padding={20}
          backgroundColor={'$backgroundHover'}
          borderTopLeftRadius={24}
          borderTopRightRadius={24}
        >
          <Sheet.Handle backgroundColor={'$borderColor'} />
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
                      preferences.videoQuality === quality ? '$backgroundPress' : '$borderColor'
                    }
                    borderWidth={preferences.videoQuality === quality ? 2 : 0}
                    borderColor={'$primary'}
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <YStack>
                      <Text fontWeight="600" fontSize={16}>
                        {quality === 'auto'
                          ? 'Auto'
                          : quality === 'hd'
                            ? 'High (HD)'
                            : 'Standard (SD)'}
                      </Text>
                      <Text fontSize={13} color={'$placeholderColor'}>
                        {quality === 'auto'
                          ? 'Adjusts based on network speed'
                          : quality === 'hd'
                            ? 'Best quality, uses more data'
                            : 'Lower quality, saves data'}
                      </Text>
                    </YStack>
                    {preferences.videoQuality === quality && <Video size={20} color={'$primary'} />}
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
