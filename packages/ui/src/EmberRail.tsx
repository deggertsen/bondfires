import { Flame } from '@tamagui/lucide-icons'
import { Image } from 'expo-image'
import { Pressable, ScrollView } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { Text } from './Text'

export type EmberRailItem = {
  id: string
  /** Short label shown under the ring (thread title or fallback). */
  label: string
  thumbnailUrl: string | null
  /** True when the thread has unseen responses — copper ring + badge. */
  unread: boolean
  /** True for the viewer's own spark with no responses yet — gold spark-dot. */
  isUnansweredSpark: boolean
}

export type EmberRailProps = {
  /** Threads to show, already sorted (unread first, quiet after). */
  items: EmberRailItem[]
  /** Total thread count shown on the lead "All fires" tile. */
  totalCount: number
  onOpenItem: (id: string) => void
  onOpenAll: () => void
  /** Optional renderer for stores that resolve thumbnails reactively. */
  renderThumbnail?: (item: EmberRailItem) => React.ReactNode
}

const RING_SIZE = 56
const RING_WIDTH = 2

function RailTile({
  label,
  muted,
  accessibilityLabel,
  onPress,
  children,
}: {
  label: string
  muted?: boolean
  accessibilityLabel: string
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <YStack width={RING_SIZE + 8} alignItems="center" gap={4}>
        {children}
        <Text
          fontSize={10}
          fontWeight="600"
          color={muted ? '$placeholderColor' : '$color'}
          numberOfLines={1}
        >
          {label}
        </Text>
      </YStack>
    </Pressable>
  )
}

function CountBadge({ count }: { count: number }) {
  return (
    <YStack
      position="absolute"
      bottom={-2}
      right={-4}
      minWidth={18}
      height={18}
      paddingHorizontal={4}
      borderRadius={9}
      backgroundColor="$backgroundPress"
      borderWidth={2}
      borderColor="$background"
      alignItems="center"
      justifyContent="center"
    >
      <Text fontSize={9} fontWeight="900" color="$color">
        {count > 99 ? '99+' : count}
      </Text>
    </YStack>
  )
}

/**
 * Horizontal rail of the viewer's fires, pinned to the top of Home.
 *
 * Reads like a status strip: the lead tile opens the full "Your fires"
 * list (the unchanged My Fires screen), unread threads glow with a copper
 * ring and dot, quiet threads sit dimmed after them, and the viewer's own
 * unanswered sparks carry a gold spark-dot as a gentle re-engagement nudge.
 */
export function EmberRail({
  items,
  totalCount,
  onOpenItem,
  onOpenAll,
  renderThumbnail,
}: EmberRailProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
    >
      <RailTile
        label="All fires"
        accessibilityLabel={`All fires, ${totalCount} ${totalCount === 1 ? 'thread' : 'threads'}`}
        onPress={onOpenAll}
      >
        <YStack
          width={RING_SIZE}
          height={RING_SIZE}
          borderRadius={RING_SIZE / 2}
          borderWidth={1.5}
          borderColor="$borderColor"
          borderStyle="dashed"
          backgroundColor="$backgroundHover"
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={20} color="$primary" />
          <CountBadge count={totalCount} />
        </YStack>
      </RailTile>

      {items.map((item) => (
        <RailTile
          key={item.id}
          label={item.label}
          muted={!item.unread}
          accessibilityLabel={
            item.unread ? `${item.label}, new responses` : `${item.label}, no new activity`
          }
          onPress={() => onOpenItem(item.id)}
        >
          <YStack
            width={RING_SIZE}
            height={RING_SIZE}
            borderRadius={RING_SIZE / 2}
            borderWidth={RING_WIDTH}
            borderColor={item.unread ? '$primary' : '$borderColor'}
            padding={2}
          >
            <YStack
              flex={1}
              borderRadius={(RING_SIZE - RING_WIDTH * 2 - 4) / 2}
              overflow="hidden"
              backgroundColor="$backgroundHover"
              alignItems="center"
              justifyContent="center"
              opacity={item.unread ? 1 : 0.6}
            >
              {renderThumbnail ? (
                renderThumbnail(item)
              ) : item.thumbnailUrl ? (
                <Image
                  source={{ uri: item.thumbnailUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              ) : (
                <Flame size={18} color="$primary" />
              )}
            </YStack>
            {item.unread ? (
              <XStack
                position="absolute"
                bottom={-1}
                right={-1}
                width={14}
                height={14}
                borderRadius={7}
                backgroundColor="$primary"
                borderWidth={2}
                borderColor="$background"
              />
            ) : item.isUnansweredSpark ? (
              <XStack
                position="absolute"
                top={-1}
                right={-1}
                width={10}
                height={10}
                borderRadius={5}
                backgroundColor="$secondary"
                borderWidth={2}
                borderColor="$background"
              />
            ) : null}
          </YStack>
        </RailTile>
      ))}
    </ScrollView>
  )
}
