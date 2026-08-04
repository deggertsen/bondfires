import { Button, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, ChevronUp, Flame, Share2 } from '@tamagui/lucide-icons'
import { useEffect, useMemo, useRef } from 'react'
import { FlatList, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar, Sheet, XStack, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import type { BondfireVideoItem, ThreadParticipant } from '../_lib/bondfireDetailHelpers'

// Avatar sizes are shared by the bar and the rows so the two read as one
// component. The 38px avatar is what sets the height of both.
const AVATAR_SIZE = 38
// Two lines of text (header + summary/date) fit inside the avatar, so these are
// avatar-driven. Rows give the summary a second line, hence the taller variant.
const COMPACT_ROW_HEIGHT = 54
// Uniform per-thread so the scroll-offset math stays a simple multiply.
const COMPACT_ROW_HEIGHT_WITH_SUMMARY = 68
// Ember tones from the brand palette rather than theme tokens: this circle is
// drawn both over video and on a themed sheet, and it has to stay legible in
// either place.
const INITIALS_BACKGROUND = '#A04E24'
const INITIALS_COLOR = '#F3F4F6'

// Only the first name — the avatar beside it already identifies the speaker,
// and both surfaces are too tight to spend width on a surname.
function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

// "David Eggertsen" → "DE", mononyms → one letter. Array.from so a name that
// starts with an emoji or an astral character does not get sliced in half.
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

function formatShortDate(ms: number) {
  const date = new Date(ms)
  return `${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
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
  const fallback = (
    <Text fontSize={size * 0.36} fontWeight="700" color={INITIALS_COLOR} letterSpacing={0.5}>
      {initials(name)}
    </Text>
  )

  // With no image child, Tamagui leaves the avatar's loading status at 'idle'
  // and Avatar.Fallback never paints — that is what left an empty circle on
  // every creator without a profile photo. Draw the initials directly instead,
  // and keep Avatar.Fallback only for the case it does handle: a photo that
  // exists but fails to load.
  if (!photoUrl) {
    return (
      <YStack
        width={size}
        height={size}
        borderRadius={size / 2}
        backgroundColor={INITIALS_BACKGROUND}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        {fallback}
      </YStack>
    )
  }

  return (
    <Avatar size={size} borderRadius={size / 2} flexShrink={0}>
      <Avatar.Image source={{ uri: photoUrl }} />
      <Avatar.Fallback
        backgroundColor={INITIALS_BACKGROUND}
        alignItems="center"
        justifyContent="center"
      >
        {fallback}
      </Avatar.Fallback>
    </Avatar>
  )
}

/**
 * The two lines shared by the collapsed bar and the expanded rows: who / when /
 * topic on the header line, summary below. Both surfaces render this so they
 * cannot drift apart; they differ only in colors, in how many summary lines
 * they allow, and in what sits at the end of the header line.
 */
function ThreadItemLines({
  item,
  summaryLines,
  primaryColor,
  secondaryColor,
  chipBackground,
  headerTrailing,
}: {
  item: BondfireVideoItem
  summaryLines: number
  primaryColor: string
  secondaryColor: string
  chipBackground: string
  headerTrailing?: React.ReactNode
}) {
  const tag = item.aiTags?.[0]
  const date = formatShortDate(item.createdAt)

  return (
    <YStack flex={1} minWidth={0}>
      <XStack alignItems="center" gap={8} minWidth={0}>
        <XStack alignItems="center" gap={6} flex={1} minWidth={0}>
          {item.isMainVideo ? <Flame size={11} color={'$primary'} /> : null}
          <Text
            fontSize={13}
            fontWeight="700"
            color={primaryColor}
            numberOfLines={1}
            flexShrink={1}
          >
            {firstName(item.creatorName)}
          </Text>
          {/* When a summary is present it takes the whole line below, so the
              date rides up here instead of stealing its width. */}
          {item.summary ? (
            <Text fontSize={10} color={secondaryColor} flexShrink={0}>
              {date}
            </Text>
          ) : null}
          {tag ? (
            <XStack
              backgroundColor={chipBackground}
              paddingHorizontal={6}
              paddingVertical={1}
              borderRadius={5}
              flexShrink={1}
              minWidth={0}
            >
              <Text fontSize={9} color={secondaryColor} numberOfLines={1}>
                {tag}
              </Text>
            </XStack>
          ) : null}
        </XStack>
        {headerTrailing ? (
          <XStack alignItems="center" gap={4} flexShrink={0}>
            {headerTrailing}
          </XStack>
        ) : null}
      </XStack>
      {/* The summary, or the date on its own until AI insights land. Either way
          the line is always there, so the row height never changes. */}
      <Text fontSize={11} color={secondaryColor} numberOfLines={summaryLines}>
        {item.summary ?? date}
      </Text>
    </YStack>
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

  return (
    <Pressable onPress={onPress}>
      <XStack
        alignItems="center"
        gap={10}
        height={rowHeight}
        paddingHorizontal={8}
        borderRadius={12}
        // Border on every row, transparent unless playing, so highlighting a
        // row cannot change its height and the scroll math stays exact.
        borderWidth={1}
        borderColor={isPlaying ? '$primary' : 'transparent'}
        backgroundColor={isPlaying ? '$backgroundHover' : 'transparent'}
      >
        <CreatorAvatar name={item.creatorName} photoUrl={photoUrl} size={AVATAR_SIZE} />
        <ThreadItemLines
          item={item}
          summaryLines={2}
          primaryColor={'$color'}
          secondaryColor={'$placeholderColor'}
          chipBackground={'$backgroundPress'}
          headerTrailing={
            isPlaying ? (
              <Text fontSize={9} fontWeight="800" color={'$primary'} letterSpacing={1}>
                NOW
              </Text>
            ) : isUnwatched ? (
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
            ) : (
              <Check size={12} color={'$placeholderColor'} />
            )
          }
        />
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
              size={AVATAR_SIZE}
            />
            {/* One summary line here against the rows' two: the bar has to stay
                inside the avatar's height so it never grows over the video. */}
            <ThreadItemLines
              item={currentItem}
              summaryLines={1}
              primaryColor={OVERLAY_COLORS.textPrimary}
              secondaryColor={OVERLAY_COLORS.textSecondary}
              chipBackground="rgba(255,255,255,0.14)"
              headerTrailing={
                <>
                  <Text fontSize={12} fontWeight="600" color={OVERLAY_COLORS.textSecondary}>
                    {currentVideoIndex + 1} / {totalVideos}
                  </Text>
                  <ChevronUp size={13} color={OVERLAY_COLORS.textSecondary} />
                </>
              }
            />
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
