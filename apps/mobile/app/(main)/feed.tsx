import { Button, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { useQuery } from 'convex/react'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { Flame, MessageCircle, Eye, Play } from '@tamagui/lucide-icons'
import { useCallback, useRef, useState } from 'react'
import { Dimensions, FlatList, Pressable, StatusBar, ViewToken } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { LinearGradient } from 'expo-linear-gradient'
import { api } from '../../../../convex/_generated/api'

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')
// Account for status bar and tab bar
const ITEM_HEIGHT = SCREEN_HEIGHT

interface BondfireData {
  _id: string
  creatorName?: string
  videoCount: number
  viewCount?: number
  thumbnailUrl?: string
  createdAt: number
}

interface BondfireItemProps {
  bondfire: BondfireData
  isActive: boolean
  onPress: () => void
  onRespond: () => void
}

function BondfireItem({ bondfire, isActive, onPress, onRespond }: BondfireItemProps) {
  const timeAgo = getTimeAgo(bondfire.createdAt)

  return (
    <Pressable onPress={onPress} style={{ width: SCREEN_WIDTH, height: ITEM_HEIGHT }}>
      <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
        {/* Video/Thumbnail area */}
        <YStack flex={1} alignItems="center" justifyContent="center">
          {bondfire.thumbnailUrl ? (
            <Image
              source={{ uri: bondfire.thumbnailUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
            />
          ) : (
            <YStack flex={1} alignItems="center" justifyContent="center">
              <Flame size={120} color={bondfireColors.bondfireCopper} />
              {isActive && (
                <YStack
                  position="absolute"
                  width={80}
                  height={80}
                  borderRadius={40}
                  backgroundColor="rgba(217, 119, 54, 0.3)"
                  alignItems="center"
                  justifyContent="center"
                >
                  <Play size={40} color={bondfireColors.whiteSmoke} fill={bondfireColors.whiteSmoke} />
                </YStack>
              )}
            </YStack>
          )}
        </YStack>

        {/* Bottom gradient overlay */}
        <LinearGradient
          colors={['transparent', 'rgba(20, 20, 22, 0.8)', bondfireColors.obsidian]}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 250,
          }}
        />

        {/* Bottom info section */}
        <YStack
          position="absolute"
          bottom={100}
          left={0}
          right={0}
          paddingHorizontal={20}
          gap={12}
        >
          {/* Creator info */}
          <XStack alignItems="center" gap={12}>
            <YStack
              width={48}
              height={48}
              borderRadius={24}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.bondfireCopper}
            >
              <Text fontSize={20}>🔥</Text>
            </YStack>
            <YStack>
              <Text fontWeight="700" fontSize={16}>
                {bondfire.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={13} color={bondfireColors.ash}>
                {timeAgo}
              </Text>
            </YStack>
          </XStack>

          {/* Stats row */}
          <XStack gap={20}>
            <XStack alignItems="center" gap={6}>
              <Eye size={18} color={bondfireColors.ash} />
              <Text fontSize={14} color={bondfireColors.ash}>
                {bondfire.viewCount ?? 0}
              </Text>
            </XStack>
            <XStack alignItems="center" gap={6}>
              <MessageCircle size={18} color={bondfireColors.ash} />
              <Text fontSize={14} color={bondfireColors.ash}>
                {bondfire.videoCount} {bondfire.videoCount === 1 ? 'response' : 'responses'}
              </Text>
            </XStack>
          </XStack>
        </YStack>

        {/* Right side action buttons */}
        <YStack
          position="absolute"
          right={16}
          bottom={160}
          gap={20}
          alignItems="center"
        >
          <Pressable onPress={onRespond}>
            <YStack alignItems="center" gap={4}>
              <YStack
                width={48}
                height={48}
                borderRadius={24}
                backgroundColor={bondfireColors.bondfireCopper}
                alignItems="center"
                justifyContent="center"
              >
                <Flame size={24} color={bondfireColors.whiteSmoke} />
              </YStack>
              <Text fontSize={12} color={bondfireColors.whiteSmoke}>
                Respond
              </Text>
            </YStack>
          </Pressable>
        </YStack>
      </YStack>
    </Pressable>
  )
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

function EmptyFeed() {
  const router = useRouter()

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
      paddingHorizontal={40}
    >
      <YStack
        width={120}
        height={120}
        borderRadius={60}
        backgroundColor={bondfireColors.gunmetal}
        alignItems="center"
        justifyContent="center"
        marginBottom={32}
      >
        <Flame size={60} color={bondfireColors.bondfireCopper} />
      </YStack>
      <Text fontSize={24} fontWeight="700" marginBottom={12} textAlign="center">
        Spark a Bondfire
      </Text>
      <Text fontSize={16} color={bondfireColors.ash} textAlign="center" marginBottom={32}>
        Be the first to share a video!
      </Text>
      <Button variant="primary" size="$lg" onPress={() => router.push('/(main)/create')}>
        <Flame size={20} color={bondfireColors.whiteSmoke} />
        <Text color={bondfireColors.whiteSmoke}>Spark Bondfire</Text>
      </Button>
    </YStack>
  )
}

function LoadingFeed() {
  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
    >
      <Spinner size="large" color={bondfireColors.bondfireCopper} />
      <Text marginTop={20} color={bondfireColors.ash}>
        Loading bondfires...
      </Text>
    </YStack>
  )
}

export default function FeedScreen() {
  const router = useRouter()
  const bondfires = useQuery(api.bondfires.listFeed, { limit: 20 })
  const [activeIndex, setActiveIndex] = useState(0)
  const flatListRef = useRef<FlatList>(null)

  const handleBondfirePress = useCallback(
    (bondfireId: string) => {
      router.push(`/(main)/bondfire/${bondfireId}`)
    },
    [router],
  )

  const handleRespond = useCallback(
    (bondfireId: string) => {
      router.push(`/(main)/create?respondTo=${bondfireId}`)
    },
    [router],
  )

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        setActiveIndex(viewableItems[0].index)
      }
    },
    [],
  )

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current

  if (bondfires === undefined) {
    return <LoadingFeed />
  }

  if (bondfires.length === 0) {
    return <EmptyFeed />
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
      
      <FlatList
        ref={flatListRef}
        data={bondfires}
        keyExtractor={(item) => item._id}
        renderItem={({ item, index }) => (
          <BondfireItem
            bondfire={item}
            isActive={index === activeIndex}
            onPress={() => handleBondfirePress(item._id)}
            onRespond={() => handleRespond(item._id)}
          />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        getItemLayout={(_, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * index,
          index,
        })}
      />
    </YStack>
  )
}
