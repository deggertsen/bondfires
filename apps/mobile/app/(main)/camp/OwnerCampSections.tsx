import { parseError, subscriptionActions } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, ColorPicker, StatCard, Text } from '@bondfires/ui'
import { ImagePlus } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useState } from 'react'
import { Alert, Pressable } from 'react-native'
import { Image, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'

const LOADING_SKELETON_IDS = ['kindling-one', 'kindling-two', 'kindling-three'] as const

function LoadingSkeleton() {
  return (
    <YStack gap={4}>
      {LOADING_SKELETON_IDS.map((id) => (
        <YStack
          key={id}
          height={40}
          borderRadius={10}
          backgroundColor={`${bondfireColors.iron}40`}
        />
      ))}
    </YStack>
  )
}

function KindlingBalanceSection() {
  const summary = useQuery(api.campKindling.getKindlingUsageSummary)

  if (summary === undefined) {
    return (
      <YStack gap={12}>
        <Text fontSize={14} color={bondfireColors.bondfireCopper} fontWeight="900">
          CAMP KINDLING
        </Text>
        <LoadingSkeleton />
      </YStack>
    )
  }

  const balanceColor = summary.balance > 0 ? bondfireColors.success : bondfireColors.error
  const handleGetMoreKindling = () => {
    subscriptionActions.showPaywall()
  }

  return (
    <YStack gap={12}>
      <Text fontSize={14} color={bondfireColors.bondfireCopper} fontWeight="900">
        CAMP KINDLING
      </Text>

      <YStack
        padding={16}
        borderRadius={14}
        backgroundColor={bondfireColors.gunmetal}
        borderWidth={1}
        borderColor={bondfireColors.iron}
        gap={8}
      >
        <XStack alignItems="baseline" gap={8}>
          <Text fontSize={36} fontWeight="900" color={balanceColor}>
            {summary.balance}
          </Text>
          <Text fontSize={14} color={bondfireColors.ash}>
            kindling remaining
          </Text>
        </XStack>

        <XStack gap={16}>
          <XStack alignItems="center" gap={4}>
            <Text fontSize={12} color={bondfireColors.success} fontWeight="900">
              +{summary.kindlingGrantedThisPeriod}
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              granted this month
            </Text>
          </XStack>
          <XStack alignItems="center" gap={4}>
            <Text fontSize={12} color={bondfireColors.error} fontWeight="900">
              -{summary.kindlingBurnedThisPeriod}
            </Text>
            <Text fontSize={12} color={bondfireColors.ash}>
              consumed this month
            </Text>
          </XStack>
        </XStack>

        {summary.activeCamps.length > 0 ? (
          <YStack gap={6} marginTop={4}>
            <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
              ACTIVE CAMPS ({summary.activeCamps.length})
            </Text>
            {summary.activeCamps.map((activeCamp) => (
              <XStack
                key={activeCamp.campId}
                justifyContent="space-between"
                alignItems="center"
                paddingVertical={6}
                gap={8}
              >
                <Text fontSize={13} color={bondfireColors.whiteSmoke} flex={1} numberOfLines={1}>
                  {activeCamp.name}
                </Text>
                <XStack gap={8} alignItems="center">
                  <Text fontSize={11} color={bondfireColors.ash}>
                    Renews{' '}
                    {new Date(activeCamp.renewalDate).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </Text>
                  <Text fontSize={11} color={bondfireColors.ash} fontWeight="900">
                    {activeCamp.kindlingCost} kindling
                  </Text>
                </XStack>
              </XStack>
            ))}
          </YStack>
        ) : null}

        {summary.balance < 3 ? (
          <Button variant="outline" size="$sm" onPress={handleGetMoreKindling} marginTop={4}>
            <Text color={bondfireColors.bondfireCopper} fontWeight="900">
              Get More Kindling
            </Text>
          </Button>
        ) : null}
      </YStack>
    </YStack>
  )
}

function AnalyticsSection({ campId }: { campId: Id<'camps'> }) {
  const analytics = useQuery(api.campAnalytics.getCampAnalytics, { campId })

  if (analytics === undefined) {
    return (
      <YStack gap={12}>
        <Text fontSize={14} color={bondfireColors.bondfireCopper} fontWeight="900">
          ANALYTICS
        </Text>
        <LoadingSkeleton />
      </YStack>
    )
  }

  return (
    <YStack gap={12}>
      <Text fontSize={14} color={bondfireColors.bondfireCopper} fontWeight="900">
        ANALYTICS
      </Text>
      <XStack gap={10}>
        <StatCard value={analytics.activeMembers} label="Active Members" />
        <StatCard value={analytics.totalBondfires} label="Bondfires" />
        <StatCard value={analytics.totalResponses} label="Responses" />
      </XStack>
    </YStack>
  )
}

function BrandingEditor({ camp }: { camp: Doc<'camps'> }) {
  const generateUploadUrl = useMutation(api.campBranding.generateCampCoverImageUploadUrl)
  const updateCampBranding = useMutation(api.campBranding.updateCampBranding)
  const [isUploading, setIsUploading] = useState(false)
  const [isSavingAccentColor, setIsSavingAccentColor] = useState(false)
  const campId = camp._id

  const handleCoverImageTap = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    })

    if (result.canceled || !result.assets[0]) return

    setIsUploading(true)
    try {
      const manipulated = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1200, height: 675 } }],
        { compress: 0.85, format: SaveFormat.JPEG },
      )

      const uploadUrl = await generateUploadUrl()

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
      await updateCampBranding({ campId, coverImageStorageId: storageId })
    } catch (error) {
      const message = parseError(error).message
      Alert.alert('Upload Failed', message)
    } finally {
      setIsUploading(false)
    }
  }, [campId, generateUploadUrl, updateCampBranding])

  const handleAccentColorChange = useCallback(
    async (color: string) => {
      if (color === camp.accentColor) return

      setIsSavingAccentColor(true)
      try {
        await updateCampBranding({ campId, accentColor: color })
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Branding Update Failed', message)
      } finally {
        setIsSavingAccentColor(false)
      }
    },
    [camp.accentColor, campId, updateCampBranding],
  )

  return (
    <YStack gap={12}>
      <Text fontSize={14} color={bondfireColors.bondfireCopper} fontWeight="900">
        BRANDING
      </Text>

      {/* Cover Image */}
      <YStack gap={8}>
        <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
          COVER IMAGE
        </Text>
        <Pressable onPress={handleCoverImageTap}>
          <YStack
            width="100%"
            height={160}
            borderRadius={14}
            backgroundColor={bondfireColors.gunmetal}
            borderWidth={1}
            borderColor={bondfireColors.iron}
            overflow="hidden"
            alignItems="center"
            justifyContent="center"
          >
            {isUploading ? (
              <YStack gap={8} alignItems="center">
                <Spinner size="large" color={bondfireColors.bondfireCopper} />
                <Text fontSize={12} color={bondfireColors.ash}>
                  Uploading...
                </Text>
              </YStack>
            ) : camp.coverImageUrl ? (
              <Image
                source={{ uri: camp.coverImageUrl }}
                width="100%"
                height="100%"
                resizeMode="cover"
              />
            ) : (
              <YStack gap={6} alignItems="center">
                <ImagePlus size={32} color={bondfireColors.ash} />
                <Text fontSize={13} color={bondfireColors.ash}>
                  Tap to add cover image
                </Text>
              </YStack>
            )}
          </YStack>
        </Pressable>
      </YStack>

      {/* Accent Color */}
      <YStack gap={8}>
        <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
          ACCENT COLOR
        </Text>
        <YStack
          padding={14}
          borderRadius={14}
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.iron}
          gap={10}
        >
          <ColorPicker
            value={camp.accentColor ?? ''}
            onChange={handleAccentColorChange}
            disabled={isSavingAccentColor}
          />
          {camp.accentColor ? (
            <XStack alignItems="center" gap={8}>
              <YStack
                width={16}
                height={16}
                borderRadius={8}
                backgroundColor={camp.accentColor}
                borderWidth={1}
                borderColor={bondfireColors.iron}
              />
              <Text fontSize={12} color={bondfireColors.ash}>
                Current: {camp.accentColor}
              </Text>
            </XStack>
          ) : null}
        </YStack>
      </YStack>
    </YStack>
  )
}

interface OwnerCampSectionsProps {
  camp: Doc<'camps'>
}

export function OwnerCampSections({ camp }: OwnerCampSectionsProps) {
  const subscription = useQuery(api.subscriptions.current, {})
  const isPro = subscription?.tier === 'pro'

  return (
    <YStack gap={24} paddingHorizontal={16} paddingBottom={24}>
      {isPro ? <KindlingBalanceSection /> : null}
      <AnalyticsSection campId={camp._id} />
      <BrandingEditor camp={camp} />
    </YStack>
  )
}
