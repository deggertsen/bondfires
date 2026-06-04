import { parseError } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, ColorPicker, Image, StatCard, Text } from '@bondfires/ui'
import { useMutation, useQuery } from 'convex/react'
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { ACCENT_PALETTE } from '../../../../../convex/campBranding'

type OwnerCampSectionsProps = {
  campId: Id<'camps'>
}

/**
 * Owner-only sections: camp analytics, slot balance, and branding.
 * Each sub-section handles its own Convex queries/mutations.
 */
export function OwnerCampSections({ campId }: OwnerCampSectionsProps) {
  const analytics = useQuery(api.campAnalytics.getCampAnalytics, { campId })
  const slotSummary = useQuery(api.campSlots.getSlotUsageSummary, {})
  const camp = useQuery(api.camps.get, { campId })

  const updateBranding = useMutation(api.campBranding.updateCampBranding)
  const generateCoverUploadUrl = useMutation(api.campBranding.generateCampCoverUploadUrl)
  const updateCoverImage = useMutation(api.campBranding.updateCampCoverImage)

  const [isUploadingCover, setIsUploadingCover] = useState(false)

  const handleAccentColorSelect = useCallback(
    async (color: string) => {
      try {
        await updateBranding({ campId, accentColor: color })
      } catch (error) {
        Alert.alert('Branding Error', parseError(error).message)
      }
    },
    [campId, updateBranding],
  )

  const handleCoverImagePick = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.8,
      })

      if (result.canceled || !result.assets[0]) return

      setIsUploadingCover(true)

      const manipulated = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1280 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      )

      const uploadUrl = await generateCoverUploadUrl({ campId })

      const uploadResponse = await fetch(manipulated.uri)
      const blob = await uploadResponse.blob()
      const postResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      })

      if (!postResponse.ok) {
        throw new Error(`Upload failed: ${postResponse.status}`)
      }

      const { storageId } = (await postResponse.json()) as { storageId: Id<'_storage'> }
      await updateCoverImage({ campId, storageId })
    } catch (error) {
      Alert.alert('Cover Upload Error', parseError(error).message)
    } finally {
      setIsUploadingCover(false)
    }
  }, [campId, generateCoverUploadUrl, updateCoverImage])

  return (
    <YStack gap={20}>
      {/* ── Analytics ──────────────────────────────────── */}
      <YStack gap={10}>
        <Text fontSize={15} fontWeight="900" color={bondfireColors.whiteSmoke}>
          Camp Analytics
        </Text>
        {analytics ? (
          <XStack gap={8}>
            <StatCard
              label="Members"
              value={analytics.activeMembers}
              accentColor={camp?.accentColor}
            />
            <StatCard
              label="Bondfires"
              value={analytics.totalBondfires}
              accentColor={camp?.accentColor}
            />
            <StatCard
              label="Responses"
              value={analytics.totalResponses}
              accentColor={camp?.accentColor}
            />
          </XStack>
        ) : (
          <Spinner size="small" color={bondfireColors.bondfireCopper} />
        )}
      </YStack>

      {/* ── Slot Balance ────────────────────────────────── */}
      {slotSummary ? (
        <YStack
          backgroundColor={bondfireColors.gunmetal}
          borderRadius={14}
          borderWidth={1}
          borderColor={bondfireColors.iron}
          padding={16}
          gap={12}
        >
          <Text fontSize={15} fontWeight="900" color={bondfireColors.whiteSmoke}>
            Slot Balance
          </Text>
          <XStack gap={16} alignItems="center">
            <YStack flex={1} alignItems="center" gap={2}>
              <Text fontSize={28} fontWeight="900" color={bondfireColors.moltenGold}>
                {slotSummary.balance}
              </Text>
              <Text fontSize={11} color={bondfireColors.ash} fontWeight="700">
                Available
              </Text>
            </YStack>
            <YStack flex={1} alignItems="center" gap={2}>
              <Text fontSize={20} fontWeight="900" color={bondfireColors.whiteSmoke}>
                +{slotSummary.slotsGrantedThisMonth}
              </Text>
              <Text fontSize={11} color={bondfireColors.ash} fontWeight="700">
                Granted This Month
              </Text>
            </YStack>
            <YStack flex={1} alignItems="center" gap={2}>
              <Text fontSize={20} fontWeight="900" color={bondfireColors.whiteSmoke}>
                -{slotSummary.slotsConsumedThisMonth}
              </Text>
              <Text fontSize={11} color={bondfireColors.ash} fontWeight="700">
                Consumed This Month
              </Text>
            </YStack>
          </XStack>
          {slotSummary.activeCamps.length > 0 ? (
            <YStack gap={6} marginTop={4}>
              <Text fontSize={12} fontWeight="700" color={bondfireColors.ash}>
                Active Camps
              </Text>
              {slotSummary.activeCamps.map((c) => (
                <XStack key={c.campId} justifyContent="space-between" paddingVertical={4}>
                  <Text fontSize={14} fontWeight="700" color={bondfireColors.whiteSmoke}>
                    {c.name}
                  </Text>
                  <Text fontSize={12} color={bondfireColors.ash}>
                    Renews {new Date(c.renewalDate).toLocaleDateString()}
                  </Text>
                </XStack>
              ))}
            </YStack>
          ) : null}
        </YStack>
      ) : null}

      {/* ── Branding ────────────────────────────────────── */}
      <YStack gap={12}>
        <Text fontSize={15} fontWeight="900" color={bondfireColors.whiteSmoke}>
          Camp Branding
        </Text>

        {/* Cover Image */}
        {camp?.coverImageUrl ? (
          <YStack gap={6}>
            <Text fontSize={12} fontWeight="700" color={bondfireColors.ash}>
              Cover Image
            </Text>
            <Image
              source={{ uri: camp.coverImageUrl }}
              width="$full"
              height={120}
              borderRadius={10}
              borderWidth={1}
              borderColor={bondfireColors.iron}
              resizeMode="cover"
            />
            <Button
              variant="outline"
              size="$sm"
              disabled={isUploadingCover}
              onPress={handleCoverImagePick}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="700" fontSize={13}>
                {isUploadingCover ? 'Uploading...' : 'Change Cover'}
              </Text>
            </Button>
          </YStack>
        ) : (
          <YStack gap={6}>
            <Text fontSize={12} fontWeight="700" color={bondfireColors.ash}>
              Cover Image
            </Text>
            <Button
              variant="outline"
              size="$sm"
              disabled={isUploadingCover}
              onPress={handleCoverImagePick}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="700" fontSize={13}>
                {isUploadingCover ? 'Uploading...' : 'Upload Cover Image'}
              </Text>
            </Button>
            <Text fontSize={11} color={bondfireColors.ash}>
              16:9 ratio recommended · Max 5MB
            </Text>
          </YStack>
        )}

        {/* Accent Color */}
        <YStack gap={8}>
          <Text fontSize={12} fontWeight="700" color={bondfireColors.ash}>
            Accent Color
          </Text>
          <ColorPicker
            palette={ACCENT_PALETTE}
            selected={camp?.accentColor}
            onSelect={handleAccentColorSelect}
          />
        </YStack>
      </YStack>
    </YStack>
  )
}
