import { Button, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, ChevronUp, Flame, Share2 } from '@tamagui/lucide-icons'
import { useEffect, useMemo, useRef } from 'react'
import { FlatList, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar, Sheet, XStack, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import type { BondfireVideoItem, ThreadParticipant } from '../_lib/bondfireDetailHelpers'
import { formatTime } from '../_lib/bondfireDetailHelpers'

const COMPACT_ROW_HEIGHT = 44
// Once AI summaries exist, rows gain a summary line. Uniform per-thread so the
// scroll-offset math stays a simple multiply.
const COMPACT_ROW_HEIGHT_WITH_SUMMARY = 58

function videoLabel(item: BondfireVideoItem) {
  return item.isMainVideo ? 'Spark' : `Response #${item.responseIndex}`
}

function formatShortDate(ms: number) {
  const date = new Date(ms)
  return `${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function formatTimestamp(ms: number) {
  const date = new Date(ms)
  return `${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })} at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function CreatorAvatar({
  name,
  photoUrl,
  size,
}: {
  name: string
  photoUrl?: string
  size: number
}) {
  const initial = (name[0] ?? '?').toUpperCase()
  return (
    <Avatar size={size} borderRadius={size / 2}>
      {photoUrl ? <Avatar.Image source={{ uri: photoUrl }} /> : null}
      <Avatar.Fallback
        backgroundColor={'$backgroundHover'}
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={size * 0.4} fontWeight="700" color={'$color'}>
          {initial}
        </Text>
      </Avatar.Fallback>
    </Avatar>
  )
}

function ThreadBrowserRow({
  item,
  isPlaying,
  photoUrl,
  rowHeight,
  onPress,
}: {
  item: BondfireVideoItem
  isPlaying: boolean
  photoUrl?: string
  rowHeight: number
  onPress: () => void
}) {
  const isUnwatched = !item.watchedByViewer

  if (isPlaying) {
    return (
      <Pressable onPress={onPress}>
        <XStack
          alignItems="center"
          gap={10}
          paddingVertical={8}
          paddingHorizontal={8}
          marginVertical={2}
          borderRadius={12}
          borderWidth={1}
          borderColor={'$primary'}
          backgroundColor={'$backgroundHover'}
        >
          <CreatorAvatar name={item.creatorName} photoUrl={photoUrl} size={40} />
          <YStack flex={1} minWidth={0}>
            <XStack alignItems="center" gap={6}>
              {item.isMainVideo ? <Flame size={12} color={'$primary'} /> : null}
              <Text fontSize={14} fontWeight="700" numberOfLines={1}>
                {item.creatorName}
              </Text>
            </XStack>
            <Text fontSize={11} color={'$placeholderColor'}>
              {videoLabel(item)} · {formatTimestamp(item.createdAt)}
              {item.durationMs ? ` · ${formatTime(item.durationMs)}` : ''}
            </Text>
            {item.summary ? (
              <Text fontSize={12} color={'$color'} opacity={0.8} numberOfLines={2}>
                {item.summary}
              </Text>
            ) : null}
          </YStack>
          <Text fontSize={9} fontWeight="800" color={'$primary'} letterSpacing={1}>
            NOW
          </Text>
        </XStack>
      </Pressable>
    )
  }

  return (
    <Pressable onPress={onPress}>
      <XStack alignItems="center" gap={10} height={rowHeight} paddingHorizontal={8}>
        <CreatorAvatar name={item.creatorName} photoUrl={photoUrl} size={30} />
        <YStack flex={1} minWidth={0} justifyContent="center">
          <XStack alignItems="center" gap={6} minWidth={0}>
            {item.isMainVideo ? <Flame size={11} color={'$primary'} /> : null}
            <Text fontSize={13} fontWeight="600" numberOfLines={1} flexShrink={1}>
              {item.creatorName}
            </Text>
            {isUnwatched ? (
              <XStack
                backgroundColor={'$secondary'}
                paddingHorizontal={6}
                paddingVertical={1}
                borderRadius={4}
              >
                <Text fontSize={8} fontWeight="800" color={'$background'}>
                  NEW
                </Text>
              </XStack>
            ) : null}
          </XStack>
          {item.summary ? (
            <Text fontSize={11} color={'$placeholderColor'} numberOfLines={1}>
              {item.summary}
            </Text>
          ) : null}
        </YStack>
        <Text fontSize={11} color={'$placeholderColor'}>
          {formatShortDate(item.createdAt)}
        </Text>
        <YStack width={16} alignItems="flex-end">
          {!isUnwatched ? <Check size={12} color={'$placeholderColor'} /> : null}
        </YStack>
      </XStack>
    </Pressable>
  )
}

/**
 * Thread navigation for a Bondfire: a collapsed now-playing bar that expands
 * into a half-screen browser. The video keeps playing (and stays swipeable)
 * above the sheet, so tapping a row previews that video without losing your
 * place in the list. Replaces the pagination dots, the standalone respond
 * button, and the on-video identity overlay.
 */
export function ThreadBrowser({
  title,
  videoItems,
  currentVideoIndex,
  participants,
  processingCount,
  canRespond,
  canShare,
  onSelectVideo,
  onRespond,
  onShare,
}: {
  title: string
  videoItems: BondfireVideoItem[]
  currentVideoIndex: number
  participants?: ThreadParticipant[]
  processingCount: number
  canRespond: boolean
  canShare: boolean
  onSelectVideo: (index: number) => void
  onRespond: () => void
  onShare: () => void
}) {
  const state$ = useObservable({ open: false })
  const open = useValue(state$.open)
  const listRef = useRef<FlatList<BondfireVideoItem>>(null)
  const insets = useSafeAreaInsets()

  const photoByUserId = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const participant of participants ?? []) {
      map.set(participant.user._id, participant.user.photoUrl)
    }
    return map
  }, [participants])

  const rowHeight = videoItems.some((item) => item.summary)
    ? COMPACT_ROW_HEIGHT_WITH_SUMMARY
    : COMPACT_ROW_HEIGHT

  // Imperative FlatList scroll (external object) — keeps the playing row in
  // view when it changes via row taps or swipes on the video above the sheet.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, currentVideoIndex * rowHeight - rowHeight * 1.5),
        animated: true,
      })
    }, 60)
    return () => clearTimeout(timer)
  }, [open, currentVideoIndex, rowHeight])

  const currentItem = videoItems[currentVideoIndex]
  const totalVideos = videoItems.length
  const unwatchedCount = videoItems.filter((item) => !item.watchedByViewer).length
  // At most two chips on the collapsed bar — it shares a line with the counter.
  const currentTags = currentItem?.aiTags?.slice(0, 2) ?? []

  if (!currentItem) return null

  return (
    <>
      {!open && (
        <Pressable
          onPress={() => state$.open.set(true)}
          style={{
            position: 'absolute',
            bottom: 28 + insets.bottom,
            left: 12,
            right: 12,
            zIndex: 50,
          }}
        >
          <XStack
            alignItems="center"
            gap={10}
            backgroundColor={OVERLAY_COLORS.pillBackground}
            borderRadius={16}
            paddingVertical={8}
            paddingHorizontal={10}
            borderWidth={1}
            borderColor="rgba(255,255,255,0.12)"
          >
            <CreatorAvatar
              name={currentItem.creatorName}
              photoUrl={photoByUserId.get(currentItem.videoOwnerId)}
              size={38}
            />
            <YStack flex={1} minWidth={0}>
              <XStack alignItems="center" gap={6}>
                <Text
                  fontSize={13}
                  fontWeight="700"
                  color={OVERLAY_COLORS.textPrimary}
                  numberOfLines={1}
                  flexShrink={1}
                >
                  {currentItem.creatorName}
                </Text>
                <ChevronUp size={13} color={OVERLAY_COLORS.textSecondary} />
              </XStack>
              <XStack alignItems="center" gap={5} minWidth={0}>
                <Text fontSize={11} color={OVERLAY_COLORS.textSecondary} flexShrink={0}>
                  {videoLabel(currentItem)} · {formatShortDate(currentItem.createdAt)}
                </Text>
                {currentTags.map((tag) => (
                  <XStack
                    key={tag}
                    backgroundColor="rgba(255,255,255,0.14)"
                    paddingHorizontal={6}
                    paddingVertical={1}
                    borderRadius={5}
                    flexShrink={1}
                    minWidth={0}
                  >
                    <Text fontSize={9} color={OVERLAY_COLORS.textSecondary} numberOfLines={1}>
                      {tag}
                    </Text>
                  </XStack>
                ))}
              </XStack>
            </YStack>
            <Text fontSize={12} fontWeight="600" color={OVERLAY_COLORS.textSecondary}>
              {currentVideoIndex + 1} / {totalVideos}
            </Text>
          </XStack>
        </Pressable>
      )}

      <Sheet
        open={open}
        onOpenChange={(isOpen: boolean) => state$.open.set(isOpen)}
        snapPoints={[50]}
        dismissOnSnapToBottom
      >
        {/* Transparent overlay: the video stays visible above the sheet and a
            tap on it collapses the browser. */}
        <Sheet.Overlay backgroundColor="transparent" />
        <Sheet.Frame
          backgroundColor={'$backgroundPress'}
          borderTopLeftRadius={20}
          borderTopRightRadius={20}
          paddingTop={8}
        >
          <Sheet.Handle backgroundColor={'$borderColor'} />
          <XStack
            justifyContent="space-between"
            alignItems="baseline"
            gap={10}
            paddingHorizontal={16}
            paddingTop={8}
            paddingBottom={6}
          >
            <Text fontSize={16} fontWeight="800" numberOfLines={1} flexShrink={1}>
              {title}
            </Text>
            <Text fontSize={11} color={'$placeholderColor'}>
              {totalVideos} {totalVideos === 1 ? 'video' : 'videos'}
              {unwatchedCount > 0 ? ` · ${unwatchedCount} new` : ''}
              {processingCount > 0 ? ` · ${processingCount} processing` : ''}
            </Text>
          </XStack>
          <FlatList
            ref={listRef}
            data={videoItems}
            keyExtractor={(item) => item.key}
            renderItem={({ item, index }) => (
              <ThreadBrowserRow
                item={item}
                isPlaying={index === currentVideoIndex}
                photoUrl={photoByUserId.get(item.videoOwnerId)}
                rowHeight={rowHeight}
                onPress={() => onSelectVideo(index)}
              />
            )}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
          />
          {canRespond || canShare ? (
            <XStack
              gap={10}
              paddingHorizontal={14}
              paddingTop={8}
              paddingBottom={20 + insets.bottom}
            >
              {canRespond ? (
                <Button variant="primary" size="$lg" flex={1} onPress={onRespond}>
                  <Flame size={18} color={OVERLAY_COLORS.textPrimary} />
                  <Text color={OVERLAY_COLORS.textPrimary} fontWeight="700">
                    Respond
                  </Text>
                </Button>
              ) : null}
              {canShare ? (
                <Button variant="outline" size="$lg" onPress={onShare}>
                  <Share2 size={18} color={'$color'} />
                </Button>
              ) : null}
            </XStack>
          ) : null}
        </Sheet.Frame>
      </Sheet>
    </>
  )
}
