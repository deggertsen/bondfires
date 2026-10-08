import { Button, Text, UserAvatar } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Bell, Check, ChevronDown, ChevronUp, Flame, Share2 } from '@tamagui/lucide-icons'
import { useEffect, useMemo, useRef } from 'react'
import { FlatList, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Sheet, XStack, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import type { BondfireVideoItem, ThreadParticipant } from '../_lib/bondfireDetailHelpers'
import {
  buildThreadBrowserLayout,
  getThreadFoldedCount,
  THREAD_SECTION_HEIGHTS,
  type ThreadBrowserEntry,
  type ThreadCatchUp,
} from '../_lib/threadCatchUp'

// Avatar sizes are shared by the bar and the rows so the two read as one
// component. The 38px avatar is what sets the height of both.
const AVATAR_SIZE = 38
// Two lines of text (header + summary/date) fit inside the avatar, so these are
// avatar-driven. Rows give the summary a second line, hence the taller variant.
const COMPACT_ROW_HEIGHT = 54
// Uniform per-thread so every video row shares one height in the layout math.
const COMPACT_ROW_HEIGHT_WITH_SUMMARY = 68
const SHEET_SNAP_PERCENT = 50
// A little taller on a catch-up arrival so the new videos fit under the fold row.
const CATCH_UP_SHEET_SNAP_PERCENT = 58
// A beat after arrival, so the sheet rises over a video that is already playing.
const CATCH_UP_OPEN_DELAY_MS = 350
// Unfolding the watched videos keeps the newest of them in view just above the
// new section; older ones are a scroll up.
const EARLIER_ROWS_SHOWN_ON_EXPAND = 2
const EARLIER_AVATAR_SIZE = 26
const EARLIER_AVATAR_LIMIT = 3

// Only the first name — the avatar beside it already identifies the speaker,
// and both surfaces are too tight to spend width on a surname.
function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

function formatDay(ms: number) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatShortDate(ms: number) {
  const date = new Date(ms)
  return `${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
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
  isLinked,
  photoUrl,
  rowHeight,
  onPress,
}: {
  item: BondfireVideoItem
  isPlaying: boolean
  isLinked: boolean
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
        <UserAvatar name={item.creatorName} photoUrl={photoUrl} size={AVATAR_SIZE} />
        <ThreadItemLines
          item={item}
          summaryLines={2}
          primaryColor={'$color'}
          secondaryColor={'$placeholderColor'}
          chipBackground={'$backgroundPress'}
          headerTrailing={
            <>
              {/* The video a push (or other deep link) opened the thread on. */}
              {isLinked ? <Bell size={12} color={'$secondary'} /> : null}
              {isPlaying ? (
                <Text fontSize={9} fontWeight="800" color={'$primary'} letterSpacing={1}>
                  NOW
                </Text>
              ) : isUnwatched ? (
                <NewBadge label="NEW" />
              ) : (
                <Check size={12} color={'$placeholderColor'} />
              )}
            </>
          }
        />
      </XStack>
    </Pressable>
  )
}

function NewBadge({ label }: { label: string }) {
  return (
    <XStack
      backgroundColor={'$secondary'}
      paddingHorizontal={6}
      paddingVertical={1}
      borderRadius={4}
    >
      <Text fontSize={8} fontWeight="800" color={'$background'}>
        {label}
      </Text>
    </XStack>
  )
}

/** The watched head of the thread, folded into one row on a catch-up arrival. */
function EarlierVideosRow({
  items,
  photoByUserId,
  onPress,
}: {
  items: BondfireVideoItem[]
  photoByUserId: Map<string, string | undefined>
  onPress: () => void
}) {
  const creators = useMemo(() => {
    const seen = new Map<string, BondfireVideoItem>()
    for (const item of items) {
      if (!seen.has(item.videoOwnerId)) seen.set(item.videoOwnerId, item)
    }
    return [...seen.values()].slice(0, EARLIER_AVATAR_LIMIT)
  }, [items])
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return null
  const firstDay = formatDay(first.createdAt)
  const lastDay = formatDay(last.createdAt)

  return (
    <Pressable onPress={onPress}>
      <XStack
        alignItems="center"
        gap={10}
        height={THREAD_SECTION_HEIGHTS.earlierRow}
        paddingHorizontal={8}
      >
        <XStack width={AVATAR_SIZE + 16} flexShrink={0}>
          {creators.map((item, index) => (
            <YStack
              key={item.videoOwnerId}
              marginLeft={index === 0 ? 0 : -12}
              borderRadius={EARLIER_AVATAR_SIZE}
              borderWidth={2}
              borderColor={'$backgroundPress'}
            >
              <UserAvatar
                name={item.creatorName}
                photoUrl={photoByUserId.get(item.videoOwnerId)}
                size={EARLIER_AVATAR_SIZE}
              />
            </YStack>
          ))}
        </XStack>
        <YStack flex={1} minWidth={0}>
          <Text fontSize={13} fontWeight="700" color={'$color'} numberOfLines={1}>
            {items.length} earlier videos
          </Text>
          <Text fontSize={11} color={'$placeholderColor'} numberOfLines={1}>
            All watched · {firstDay === lastDay ? firstDay : `${firstDay} – ${lastDay}`}
          </Text>
        </YStack>
        <Text fontSize={11} color={'$placeholderColor'}>
          Show
        </Text>
        <ChevronDown size={14} color={'$placeholderColor'} />
      </XStack>
    </Pressable>
  )
}

/** Sticky header over the unfolded watched videos; Hide folds them back up. */
function EarlierVideosHeader({ count, onPress }: { count: number; onPress?: () => void }) {
  return (
    <XStack
      alignItems="center"
      height={THREAD_SECTION_HEIGHTS.earlierHeader}
      paddingHorizontal={8}
      backgroundColor={'$backgroundPress'}
      borderBottomWidth={1}
      borderBottomColor={'$borderColor'}
    >
      <Text
        flex={1}
        fontSize={9}
        fontWeight="800"
        letterSpacing={1}
        color={'$placeholderColor'}
        numberOfLines={1}
      >
        EARLIER · {count} WATCHED
      </Text>
      {onPress ? (
        <Pressable onPress={onPress} hitSlop={10}>
          <XStack alignItems="center" gap={4}>
            <Text fontSize={11} color={'$placeholderColor'}>
              Hide
            </Text>
            <ChevronUp size={14} color={'$placeholderColor'} />
          </XStack>
        </Pressable>
      ) : null}
    </XStack>
  )
}

function NewSectionLabel() {
  return (
    <YStack
      height={THREAD_SECTION_HEIGHTS.newLabel}
      justifyContent="flex-end"
      paddingHorizontal={8}
    >
      <Text fontSize={9} fontWeight="800" letterSpacing={1} color={'$secondary'} paddingBottom={6}>
        NEW SINCE YOU LAST WATCHED
      </Text>
    </YStack>
  )
}

/**
 * Thread navigation for a Bondfire: a collapsed now-playing bar that expands
 * into a half-screen browser. The video keeps playing (and stays swipeable)
 * above the sheet, so tapping a row previews that video without losing your
 * place in the list. Replaces the pagination dots, the standalone respond
 * button, and the on-video identity overlay.
 *
 * On a catch-up arrival (something unwatched is not the video that starts
 * playing) the browser opens by itself, with the already-watched head of the
 * thread folded into one row above the new videos.
 */
export function ThreadBrowser({
  title,
  videoItems,
  currentVideoIndex,
  catchUp,
  catchUpAutoOpenPending,
  onCatchUpAutoOpened,
  linkedVideoKey,
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
  catchUp: ThreadCatchUp | null
  catchUpAutoOpenPending: boolean
  onCatchUpAutoOpened: () => void
  linkedVideoKey?: string
  participants?: ThreadParticipant[]
  processingCount: number
  canRespond: boolean
  canShare: boolean
  onSelectVideo: (index: number) => void
  onRespond: () => void
  onShare: () => void
}) {
  const state$ = useObservable({ open: false, earlierExpanded: false })
  const open = useValue(state$.open)
  const earlierExpandedByUser = useValue(state$.earlierExpanded)
  const listRef = useRef<FlatList<ThreadBrowserEntry>>(null)
  const pendingListOffsetRef = useRef<number | null>(null)
  const listHeightRef = useRef(0)
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

  const videoKeys = useMemo(() => videoItems.map((item) => item.key), [videoItems])
  const foldedCount = getThreadFoldedCount(videoKeys, catchUp)
  const playingEarlier = currentVideoIndex < foldedCount
  const earlierExpanded = earlierExpandedByUser || playingEarlier
  const layout = useMemo(
    () => buildThreadBrowserLayout({ videoKeys, rowHeight, catchUp, earlierExpanded }),
    [videoKeys, rowHeight, catchUp, earlierExpanded],
  )
  // Read at scroll time rather than as an effect dependency: the playing-row
  // scroll should follow the sheet opening and the playing video, while
  // folding and unfolding positions the list itself.
  const videoOffsetsRef = useRef(layout.videoOffsets)
  videoOffsetsRef.current = layout.videoOffsets

  // Imperative FlatList scroll (external object) — keeps the playing row in
  // view when it changes via row taps or swipes on the video above the sheet.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      const playingOffset = videoOffsetsRef.current[currentVideoIndex] ?? 0
      // Stay at the top while the playing row already fits there, so a
      // catch-up arrival shows the fold row and the start of what's new.
      const fitsFromTop = playingOffset + rowHeight <= listHeightRef.current
      listRef.current?.scrollToOffset({
        offset: fitsFromTop ? 0 : Math.max(0, playingOffset - rowHeight * 1.5),
        animated: true,
      })
    }, 60)
    return () => clearTimeout(timer)
  }, [open, currentVideoIndex, rowHeight])

  // Catch-up arrival: open once, then hand the flag back so returning from the
  // recorder (which remounts this screen) does not open it again.
  useEffect(() => {
    if (!catchUpAutoOpenPending) return
    const timer = setTimeout(() => {
      state$.open.set(true)
      onCatchUpAutoOpened()
    }, CATCH_UP_OPEN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [catchUpAutoOpenPending, onCatchUpAutoOpened, state$])

  // A new arrival gets its own fold preference, including a second deep link
  // into this same thread. Playback always reveals its row synchronously.
  useEffect(() => {
    if (!catchUp) return
    state$.earlierExpanded.set(false)
    pendingListOffsetRef.current = null
  }, [catchUp, state$])

  const changeOpen = (isOpen: boolean) => {
    state$.open.set(isOpen)
    // Manual interaction consumes the pending arrival too; dismissing a sheet
    // during the delay must not let the timer pop it open again.
    if (catchUpAutoOpenPending) onCatchUpAutoOpened()
  }

  const toggleEarlier = () => {
    if (playingEarlier) return
    const expanding = !earlierExpanded
    // Unfolding expands in place: land with the newest watched videos just
    // above the new section (under the sticky header) and older ones a scroll
    // up. Folding returns to the top, where the fold row is.
    pendingListOffsetRef.current = expanding
      ? Math.max(0, (foldedCount - EARLIER_ROWS_SHOWN_ON_EXPAND) * rowHeight)
      : 0
    state$.earlierExpanded.set(expanding)
  }

  const currentItem = videoItems[currentVideoIndex]
  const totalVideos = videoItems.length
  const unwatchedCount = videoItems.filter((item) => !item.watchedByViewer).length
  // What the collapsed bar flags: unwatched videos other than the one playing.
  const otherUnwatchedCount = videoItems.filter(
    (item, index) => !item.watchedByViewer && index !== currentVideoIndex,
  ).length

  if (!currentItem) return null

  return (
    <>
      {!open && (
        <Pressable
          onPress={() => changeOpen(true)}
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
            <UserAvatar
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
                  {otherUnwatchedCount > 0 ? (
                    <NewBadge label={`${otherUnwatchedCount} NEW`} />
                  ) : null}
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
        onOpenChange={changeOpen}
        snapPoints={[catchUp?.autoOpen ? CATCH_UP_SHEET_SNAP_PERCENT : SHEET_SNAP_PERCENT]}
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
            data={layout.entries}
            keyExtractor={(entry) => entry.key}
            getItemLayout={(data, index) => ({
              length: data?.[index]?.height ?? 0,
              offset: data?.[index]?.offset ?? 0,
              index,
            })}
            onLayout={(event) => {
              listHeightRef.current = event.nativeEvent.layout.height
            }}
            stickyHeaderIndices={foldedCount > 0 && earlierExpanded ? [0] : undefined}
            onContentSizeChange={() => {
              const offset = pendingListOffsetRef.current
              if (offset === null) return
              pendingListOffsetRef.current = null
              listRef.current?.scrollToOffset({ offset, animated: false })
            }}
            renderItem={({ item: entry }) => {
              switch (entry.kind) {
                case 'earlier':
                  return (
                    <EarlierVideosRow
                      items={videoItems.slice(0, foldedCount)}
                      photoByUserId={photoByUserId}
                      onPress={toggleEarlier}
                    />
                  )
                case 'earlierHeader':
                  return (
                    <EarlierVideosHeader
                      count={foldedCount}
                      onPress={playingEarlier ? undefined : toggleEarlier}
                    />
                  )
                case 'newLabel':
                  return <NewSectionLabel />
                case 'video': {
                  const item = videoItems[entry.index]
                  if (!item) return null
                  return (
                    <ThreadBrowserRow
                      item={item}
                      isPlaying={entry.index === currentVideoIndex}
                      isLinked={!item.isMainVideo && item.key === linkedVideoKey}
                      photoUrl={photoByUserId.get(item.videoOwnerId)}
                      rowHeight={rowHeight}
                      onPress={() => onSelectVideo(entry.index)}
                    />
                  )
                }
              }
            }}
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
