import { Button, Card, Container, Text } from '@bondfires/ui'
import { useQuery } from 'convex/react'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import { Dimensions, FlatList, RefreshControl } from 'react-native'
import { H1, Paragraph, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

const { width: SCREEN_WIDTH } = Dimensions.get('window')
const CARD_WIDTH = SCREEN_WIDTH - 32 // 16px padding on each side

interface BondfireCardProps {
  bondfire: {
    _id: string
    creatorName?: string
    videoCount: number
    viewCount?: number
    thumbnailKey?: string
    createdAt: number
  }
  onPress: () => void
}

function BondfireCard({ bondfire, onPress }: BondfireCardProps) {
  const timeAgo = getTimeAgo(bondfire.createdAt)

  return (
    <Card elevated interactive marginBottom="$3" padding={0} overflow="hidden" onPress={onPress}>
      {/* Thumbnail */}
      <YStack
        width={CARD_WIDTH}
        height={CARD_WIDTH * 0.6}
        backgroundColor="$gray3"
        alignItems="center"
        justifyContent="center"
      >
        {bondfire.thumbnailKey ? (
          <Image
            source={{ uri: 'placeholder-for-thumbnail' }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
          />
        ) : (
          <Text fontSize={60}>🔥</Text>
        )}

        {/* Video count badge */}
        <YStack
          position="absolute"
          top="$2"
          right="$2"
          backgroundColor="$background"
          paddingHorizontal="$2"
          paddingVertical="$1"
          borderRadius="$2"
          opacity={0.9}
        >
          <Text fontSize="$2" fontWeight="600">
            {bondfire.videoCount} {bondfire.videoCount === 1 ? 'video' : 'videos'}
          </Text>
        </YStack>
      </YStack>

      {/* Info */}
      <YStack padding="$3" gap="$1">
        <XStack justifyContent="space-between" alignItems="center">
          <Text fontWeight="600" fontSize="$4">
            {bondfire.creatorName ?? 'Anonymous'}
          </Text>
          <Text fontSize="$2" color="$gray11">
            {timeAgo}
          </Text>
        </XStack>

        <XStack gap="$3">
          <Text fontSize="$2" color="$gray11">
            👁 {bondfire.viewCount ?? 0} views
          </Text>
        </XStack>
      </YStack>
    </Card>
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
    <YStack flex={1} alignItems="center" justifyContent="center" paddingVertical="$10" gap="$4">
      <YStack
        width={100}
        height={100}
        borderRadius={50}
        backgroundColor="$orange5"
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={50}>🔥</Text>
      </YStack>
      <YStack alignItems="center" gap="$2">
        <Text fontSize="$5" fontWeight="600">
          No bondfires yet
        </Text>
        <Text color="$gray11" textAlign="center">
          Be the first to spark one!
        </Text>
      </YStack>
      <Button variant="primary" size="md" onPress={() => router.push('/(main)/create')}>
        Spark a Bondfire
      </Button>
    </YStack>
  )
}

export default function FeedScreen() {
  const router = useRouter()
  const bondfires = useQuery(api.bondfires.listFeed, { limit: 20 })

  const handleBondfirePress = useCallback(
    (bondfireId: string) => {
      router.push(`/(main)/bondfire/${bondfireId}`)
    },
    [router],
  )

  const handleRefresh = useCallback(() => {
    // Convex queries auto-refresh, but we could trigger a manual refresh here
  }, [])

  if (bondfires === undefined) {
    return (
      <Container centered>
        <Spinner size="large" color="$orange10" />
        <Text marginTop="$4" color="$gray11">
          Loading feed...
        </Text>
      </Container>
    )
  }

  return (
    <Container safe>
      <YStack paddingHorizontal="$4" paddingTop="$4">
        <H1 marginBottom="$2">Feed</H1>
        <Paragraph color="$gray11" marginBottom="$4">
          Discover bondfires and join the conversation
        </Paragraph>
      </YStack>

      {bondfires.length === 0 ? (
        <EmptyFeed />
      ) : (
        <FlatList
          data={bondfires}
          keyExtractor={(item) => item._id}
          renderItem={({ item }) => (
            <BondfireCard bondfire={item} onPress={() => handleBondfirePress(item._id)} />
          )}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} />}
        />
      )}
    </Container>
  )
}
