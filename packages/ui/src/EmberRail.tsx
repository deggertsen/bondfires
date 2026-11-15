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
  /**
   * Optional renderer for stores that resolve thumbnails reactively. `mini`
   * is the tiny row thumbnail inside the "All fires" preview, which needs a
   * smaller fallback icon than a full ring.
   */
  renderThumbnail?: (item: EmberRailItem, variant: EmberRailThumbnailVariant) => React.ReactNode
}

export type EmberRailThumbnailVariant = 'ring' | 'mini'

const RING_SIZE = 72
const RING_WIDTH = 3
const RING_PADDING = 3
const TILE_WIDTH = RING_SIZE + 8
// The "All fires" tile previews this many rows of the list it opens.
const PREVIEW_ROWS = 4
const PREVIEW_THUMB_SIZE = 11
// Lower rows fade out so the preview reads as "the list keeps going".
const PREVIEW_ROW_OPACITY = [1, 1, 0.55, 0.25]

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
      <YStack width={TILE_WIDTH} alignItems="center" gap={4}>
        {children}
        <Text
          fontSize={12}
          fontWeight={muted ? '600' : '700'}
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
      minWidth={23}
      height={23}
      paddingHorizontal={5}
      borderRadius={12}
      backgroundColor="$backgroundPress"
      borderWidth={2}
      borderColor="$background"
      alignItems="center"
      justifyContent="center"
    >
      <Text fontSize={11} fontWeight="900" color="$color">
        {count > 99 ? '99+' : count}
      </Text>
    </YStack>
  )
}

function MiniThumbnail({
  item,
  renderThumbnail,
}: {
  item: EmberRailItem
  renderThumbnail?: EmberRailProps['renderThumbnail']
}) {
  return (
    <YStack
      width={PREVIEW_THUMB_SIZE}
      height={PREVIEW_THUMB_SIZE}
      borderRadius={3}
      overflow="hidden"
      backgroundColor="$borderColor"
      alignItems="center"
      justifyContent="center"
    >
      {renderThumbnail ? (
        renderThumbnail(item, 'mini')
      ) : item.thumbnailUrl ? (
        <Image
          source={{ uri: item.thumbnailUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : null}
    </YStack>
  )
}

/**
 * The "All fires" tile: a miniature of the list it opens. Each row is a
 * thumbnail, two text bars and a tiny Respond outline, so the tile reads as
 * "a full list you can respond from" rather than as another fire.
 */
function AllFiresPreview({
  items,
  totalCount,
  renderThumbnail,
}: {
  items: EmberRailItem[]
  totalCount: number
  renderThumbnail?: EmberRailProps['renderThumbnail']
}) {
  const rows = items.slice(0, PREVIEW_ROWS)

  return (
    <YStack width={RING_SIZE} height={RING_SIZE}>
      <YStack
        width={RING_SIZE}
        height={RING_SIZE}
        borderRadius={RING_SIZE / 2}
        borderWidth={1.5}
        borderColor="$borderColor"
        backgroundColor="$backgroundHover"
        overflow="hidden"
        alignItems="center"
        justifyContent="center"
      >
        {rows.length > 0 ? (
          <YStack position="absolute" top={9} left={12} right={10} gap={3}>
            {rows.map((item, index) => (
              <YStack key={item.id} gap={3} opacity={PREVIEW_ROW_OPACITY[index] ?? 0.25}>
                {index > 0 ? <YStack height={1} backgroundColor="$borderColor" /> : null}
                <XStack height={PREVIEW_THUMB_SIZE} alignItems="center" gap={3}>
                  {item.unread ? (
                    <YStack
                      position="absolute"
                      left={-5}
                      width={3}
                      height={3}
                      borderRadius={2}
                      backgroundColor="$primary"
                    />
                  ) : null}
                  <MiniThumbnail item={item} renderThumbnail={renderThumbnail} />
                  <YStack flex={1} gap={2}>
                    <YStack
                      width={index % 2 === 0 ? '90%' : '75%'}
                      height={3}
                      borderRadius={2}
                      backgroundColor="$placeholderColor"
                      opacity={0.7}
                    />
                    <YStack
                      width={index % 2 === 0 ? '55%' : '65%'}
                      height={3}
                      borderRadius={2}
                      backgroundColor="$placeholderColor"
                      opacity={0.4}
                    />
                  </YStack>
                  <YStack
                    width={11}
                    height={7}
                    borderRadius={3}
                    borderWidth={1}
                    borderColor="$primary"
                  />
                </XStack>
              </YStack>
            ))}
          </YStack>
        ) : (
          <Flame size={24} color="$primary" />
        )}
      </YStack>
      <CountBadge count={totalCount} />
    </YStack>
  )
}

/**
 * Horizontal rail of the viewer's fires, pinned to the top of Home.
 *
 * Reads like a status strip: the lead tile previews and opens the full
 * "Your fires" list (My Fires, where every row has Respond), unread threads glow with a copper
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
      contentContainerStyle={{ gap: 15, paddingHorizontal: 16 }}
    >
      <RailTile
        label="All fires"
        accessibilityLabel={`All fires, ${totalCount} ${totalCount === 1 ? 'thread' : 'threads'}. Opens the full list, where you can respond.`}
        onPress={onOpenAll}
      >
        <AllFiresPreview items={items} totalCount={totalCount} renderThumbnail={renderThumbnail} />
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
            padding={RING_PADDING}
          >
            <YStack
              flex={1}
              borderRadius={(RING_SIZE - RING_WIDTH * 2 - RING_PADDING * 2) / 2}
              overflow="hidden"
              backgroundColor="$backgroundHover"
              alignItems="center"
              justifyContent="center"
              opacity={item.unread ? 1 : 0.6}
            >
              {renderThumbnail ? (
                renderThumbnail(item, 'ring')
              ) : item.thumbnailUrl ? (
                <Image
                  source={{ uri: item.thumbnailUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              ) : (
                <Flame size={22} color="$primary" />
              )}
            </YStack>
            {item.unread ? (
              <XStack
                position="absolute"
                bottom={-1}
                right={-1}
                width={18}
                height={18}
                borderRadius={9}
                backgroundColor="$primary"
                borderWidth={2}
                borderColor="$background"
              />
            ) : item.isUnansweredSpark ? (
              <XStack
                position="absolute"
                top={-1}
                right={-1}
                width={13}
                height={13}
                borderRadius={7}
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
