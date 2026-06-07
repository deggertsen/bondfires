import { bondfireColors } from '@bondfires/config'
import { ChevronDown, ChevronUp, Search, Shield } from '@tamagui/lucide-icons'
import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { ScrollView, Spinner, XStack, YStack } from 'tamagui'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'
import { Text } from './Text'

type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'

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
}

type AdminPanelProps = {
  isAdmin: boolean
  onSearch: (emailQuery: string) => Promise<AdminSearchResult[]>
  onSetTier: (email: string, tier: SubscriptionTier | null) => Promise<AdminSearchResult | null>
}

export function AdminPanel({ isAdmin, onSearch, onSetTier }: AdminPanelProps) {
  const [emailQuery, setEmailQuery] = useState('')
  const [searchResults, setSearchResults] = useState<AdminSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

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
                setSearchResults((prev) => prev.map((u) => (u.email === email ? updated : u)))
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
            <Shield size={18} color={bondfireColors.moltenGold} />
            <Text fontSize={16} fontWeight="700">
              Admin Panel
            </Text>
          </XStack>
          {expanded ? (
            <ChevronUp size={18} color={bondfireColors.ash} />
          ) : (
            <ChevronDown size={18} color={bondfireColors.ash} />
          )}
        </XStack>
      </Card>

      {expanded && (
        <Card>
          <YStack gap={16}>
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
                  <Spinner size="small" color={bondfireColors.whiteSmoke} />
                ) : (
                  <>
                    <Search size={16} color={bondfireColors.whiteSmoke} />
                    <Text color={bondfireColors.whiteSmoke}>Search</Text>
                  </>
                )}
              </Button>
            </XStack>

            {searchError && (
              <Text fontSize={13} color={bondfireColors.error}>
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
                              <Text fontSize={12} color={bondfireColors.ash}>
                                {user.email}
                              </Text>
                              <Text fontSize={12} color={bondfireColors.ash}>
                                Current:{' '}
                                {user.forcedTier ? TIER_LABELS[user.forcedTier] : 'Store default'}
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
                                      color={
                                        isCurrent ? bondfireColors.whiteSmoke : bondfireColors.ash
                                      }
                                    >
                                      {isUpdating && isCurrent ? '...' : option.label}
                                    </Text>
                                  </Button>
                                )
                              })}
                            </XStack>
                          </ScrollView>
                        </YStack>
                      </Card>
                    )
                  })}
                </YStack>
              </ScrollView>
            )}
          </YStack>
        </Card>
      )}
    </YStack>
  )
}
