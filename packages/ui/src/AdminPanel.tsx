import { ChevronDown, ChevronUp, Search, Shield, Smartphone } from '@tamagui/lucide-icons'
import { useCallback, useEffect, useState } from 'react'
import { Alert } from 'react-native'
import { ScrollView, XStack, YStack } from 'tamagui'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'
import { Spinner } from './Spinner'
import { Text } from './Text'

type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'
type UpdatePriority = 'flexible' | 'immediate'

type UpdateConfig = {
  minAppVersion: string | null
  updatePriority: UpdatePriority
  updatedAt: number | null
}

const TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  plus: 'Plus',
  premium: 'Premium',
  pro: 'Pro',
}

const TIER_OPTIONS: Array<{ value: SubscriptionTier | null; label: string }> = [
  { value: null, label: 'None (clear)' },
  { value: 'free', label: 'Free' },
  { value: 'plus', label: 'Plus' },
  { value: 'premium', label: 'Premium' },
  { value: 'pro', label: 'Pro' },
]

type AdminSearchResult = {
  _id: string
  email?: string
  name?: string
  forcedTier: SubscriptionTier | null
  kindlingBalance?: number
}

type AdminPanelProps = {
  isAdmin: boolean
  onSearch: (emailQuery: string) => Promise<AdminSearchResult[]>
  onSetTier: (email: string, tier: SubscriptionTier | null) => Promise<AdminSearchResult | null>
  onGrantKindling: (email: string, amount: number) => Promise<AdminSearchResult | null>
  updateConfig: UpdateConfig | undefined
  onSetMinVersion: (version: string, priority: UpdatePriority) => Promise<UpdateConfig>
}

export function AdminPanel({
  isAdmin,
  onSearch,
  onSetTier,
  onGrantKindling,
  updateConfig,
  onSetMinVersion,
}: AdminPanelProps) {
  const [emailQuery, setEmailQuery] = useState('')
  const [searchResults, setSearchResults] = useState<AdminSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [kindlingAmount, setKindlingAmount] = useState('')
  const [grantingId, setGrantingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [minVersion, setMinVersion] = useState('')
  const [updatePriority, setUpdatePriority] = useState<UpdatePriority>('immediate')
  const [isUpdatingConfig, setIsUpdatingConfig] = useState(false)

  useEffect(() => {
    if (!updateConfig) return
    setMinVersion(updateConfig.minAppVersion ?? '')
    setUpdatePriority(updateConfig.updatePriority)
  }, [updateConfig])

  const handleSearch = useCallback(async () => {
    const query = emailQuery.trim()
    if (query.length < 2) return
    setIsSearching(true)
    setSearchError(null)
    try {
      const result = await onSearch(query)
      setSearchResults(result)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setIsSearching(false)
    }
  }, [emailQuery, onSearch])

  const handleSetTier = useCallback(
    async (email: string, tier: SubscriptionTier | null) => {
      const tierLabel = tier === null ? 'None' : TIER_LABELS[tier]
      Alert.alert('Confirm Tier Change', `Set ${email} to ${tierLabel}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setUpdatingId(email)
            try {
              const updated = await onSetTier(email, tier)
              if (updated) {
                setSearchResults((prev) =>
                  prev.map((u) => (u.email === email ? { ...u, ...updated } : u)),
                )
              }
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to update tier')
            } finally {
              setUpdatingId(null)
            }
          },
        },
      ])
    },
    [onSetTier],
  )

  const handleGrantKindling = useCallback(
    async (email: string) => {
      const amount = parseInt(kindlingAmount, 10)
      if (!Number.isInteger(amount) || amount <= 0) {
        Alert.alert('Invalid Amount', 'Enter a positive number of kindling to grant.')
        return
      }
      Alert.alert('Confirm Kindling Grant', `Grant ${amount} kindling to ${email}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setGrantingId(email)
            try {
              const updated = await onGrantKindling(email, amount)
              if (updated) {
                setSearchResults((prev) =>
                  prev.map((u) => (u.email === email ? { ...u, ...updated } : u)),
                )
              }
              setKindlingAmount('')
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to grant kindling')
            } finally {
              setGrantingId(null)
            }
          },
        },
      ])
    },
    [kindlingAmount, onGrantKindling],
  )

  const handleSetMinVersion = useCallback(() => {
    const version = minVersion.trim()
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      Alert.alert('Invalid Version', 'Use major.minor.patch format, for example 1.2.3.')
      return
    }

    const priorityLabel = updatePriority === 'immediate' ? 'blocking' : 'flexible on Android'
    Alert.alert(
      'Confirm Minimum Version',
      `Require version ${version} with a ${priorityLabel} update? Users below this version may be unable to continue. Confirm the version is available in both stores first.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Update Policy',
          style: 'destructive',
          onPress: async () => {
            setIsUpdatingConfig(true)
            try {
              await onSetMinVersion(version, updatePriority)
              Alert.alert('Update Policy Saved', `Minimum app version is now ${version}.`)
            } catch (err) {
              Alert.alert(
                'Error',
                err instanceof Error ? err.message : 'Failed to update the minimum version',
              )
            } finally {
              setIsUpdatingConfig(false)
            }
          },
        },
      ],
    )
  }, [minVersion, onSetMinVersion, updatePriority])

  if (!isAdmin) return null

  return (
    <YStack gap={12} marginBottom={24}>
      <Card
        interactive
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel="Toggle Admin Panel"
      >
        <XStack justifyContent="space-between" alignItems="center">
          <XStack alignItems="center" gap={8}>
            <Shield size={18} color={'$secondary'} />
            <Text fontSize={16} fontWeight="700">
              Admin Panel
            </Text>
          </XStack>
          {expanded ? (
            <ChevronUp size={18} color={'$placeholderColor'} />
          ) : (
            <ChevronDown size={18} color={'$placeholderColor'} />
          )}
        </XStack>
      </Card>

      {expanded && (
        <YStack gap={12}>
          <Card>
            <YStack gap={14}>
              <XStack alignItems="center" gap={8}>
                <Smartphone size={18} color={'$primary'} />
                <YStack flex={1}>
                  <Text fontSize={15} fontWeight="700">
                    App Update Policy
                  </Text>
                  <Text fontSize={12} color={'$placeholderColor'}>
                    Current minimum: {updateConfig?.minAppVersion ?? 'Not configured'}
                  </Text>
                </YStack>
              </XStack>

              <Text fontSize={13} color={'$warning'}>
                Only raise this after the version is downloadable from both app stores.
              </Text>

              <Input
                value={minVersion}
                onChangeText={setMinVersion}
                placeholder="Minimum version (for example 1.2.3)"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                accessibilityLabel="Minimum app version"
                accessibilityHint="Enter a version in major dot minor dot patch format"
              />

              <YStack gap={8}>
                <Text fontSize={13} fontWeight="600">
                  Update behavior
                </Text>
                <XStack gap={8}>
                  {(['immediate', 'flexible'] as const).map((priority) => {
                    const selected = updatePriority === priority
                    const label = priority === 'immediate' ? 'Immediate' : 'Flexible'
                    return (
                      <Button
                        key={priority}
                        flex={1}
                        variant={selected ? 'primary' : 'outline'}
                        size="$sm"
                        disabled={isUpdatingConfig}
                        onPress={() => setUpdatePriority(priority)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${label} update behavior`}
                      >
                        <Text color={selected ? '$color' : '$placeholderColor'} fontSize={13}>
                          {label}
                        </Text>
                      </Button>
                    )
                  })}
                </XStack>
                <Text fontSize={12} color={'$placeholderColor'}>
                  Immediate blocks outdated users. Flexible allows Android to download in the
                  background; iOS remains blocking.
                </Text>
              </YStack>

              <Button
                variant="destructive"
                size="$sm"
                disabled={
                  isUpdatingConfig || updateConfig === undefined || minVersion.trim() === ''
                }
                onPress={handleSetMinVersion}
                accessibilityLabel="Save minimum app version policy"
              >
                {isUpdatingConfig ? (
                  <Spinner size="small" color={'$color'} />
                ) : (
                  <Text color={'$color'} fontWeight="600">
                    Save Update Policy
                  </Text>
                )}
              </Button>
            </YStack>
          </Card>

          <Card>
            <YStack gap={16}>
              <Text fontSize={15} fontWeight="700">
                User Entitlements
              </Text>
              <XStack gap={8}>
                <Input
                  flex={1}
                  value={emailQuery}
                  onChangeText={setEmailQuery}
                  placeholder="Search by email..."
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={handleSearch}
                />
                <Button
                  variant="primary"
                  size="$sm"
                  onPress={handleSearch}
                  disabled={isSearching || emailQuery.trim().length < 2}
                >
                  {isSearching ? (
                    <Spinner size="small" color={'$color'} />
                  ) : (
                    <>
                      <Search size={16} color={'$color'} />
                      <Text color={'$color'}>Search</Text>
                    </>
                  )}
                </Button>
              </XStack>

              {searchError && (
                <Text fontSize={13} color={'$error'}>
                  {searchError}
                </Text>
              )}

              {searchResults.length > 0 && (
                <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator>
                  <YStack gap={8}>
                    {searchResults.map((user) => {
                      const userEmail = user.email ?? ''
                      return (
                        <Card key={user._id} variant="outline">
                          <YStack gap={8}>
                            <XStack justifyContent="space-between" alignItems="center">
                              <YStack flex={1}>
                                <Text fontSize={14} fontWeight="600">
                                  {user.name ?? 'Unknown'}
                                </Text>
                                <Text fontSize={12} color={'$placeholderColor'}>
                                  {user.email}
                                </Text>
                                <Text fontSize={12} color={'$placeholderColor'}>
                                  Current:{' '}
                                  {user.forcedTier ? TIER_LABELS[user.forcedTier] : 'Store default'}
                                </Text>
                                <Text fontSize={12} color={'$placeholderColor'}>
                                  Kindling: {user.kindlingBalance ?? 0}
                                </Text>
                              </YStack>
                            </XStack>

                            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                              <XStack gap={6}>
                                {TIER_OPTIONS.map((option) => {
                                  const isCurrent =
                                    option.value === null
                                      ? user.forcedTier === null
                                      : user.forcedTier === option.value
                                  const isUpdating = updatingId === userEmail
                                  return (
                                    <Button
                                      key={option.label}
                                      variant={isCurrent ? 'primary' : 'outline'}
                                      size="$sm"
                                      disabled={isUpdating || isCurrent}
                                      onPress={() => handleSetTier(userEmail, option.value)}
                                    >
                                      <Text
                                        fontSize={12}
                                        color={isCurrent ? '$color' : '$placeholderColor'}
                                      >
                                        {isUpdating && isCurrent ? '...' : option.label}
                                      </Text>
                                    </Button>
                                  )
                                })}
                              </XStack>
                            </ScrollView>

                            {/* Kindling Grant */}
                            <XStack gap={6} alignItems="center">
                              <Input
                                flex={1}
                                value={grantingId === userEmail ? kindlingAmount : ''}
                                onChangeText={setKindlingAmount}
                                placeholder="Kindling amount..."
                                keyboardType="numeric"
                                returnKeyType="done"
                              />
                              <Button
                                variant="primary"
                                size="$sm"
                                disabled={grantingId === userEmail}
                                onPress={() => handleGrantKindling(userEmail)}
                              >
                                {grantingId === userEmail ? (
                                  <Spinner size="small" color={'$color'} />
                                ) : (
                                  <Text color={'$color'} fontSize={12}>
                                    Grant
                                  </Text>
                                )}
                              </Button>
                            </XStack>
                          </YStack>
                        </Card>
                      )
                    })}
                  </YStack>
                </ScrollView>
              )}
            </YStack>
          </Card>
        </YStack>
      )}
    </YStack>
  )
}
