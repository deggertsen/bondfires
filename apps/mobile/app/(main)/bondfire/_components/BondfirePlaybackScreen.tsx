import { Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { ChevronLeft, ChevronRight, FileText, Settings } from '@tamagui/lucide-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { Stack, useRouter } from 'expo-router'
import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { StatusBarStyle, ViewToken } from 'react-native'
import { FlatList, Pressable, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import { InviteSheet } from '../../../../components/InviteSheet'
import { NotepadOverlay } from '../../../../components/NotepadOverlay'
import { SettingsPopover } from '../../../../components/SettingsPopover'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import { routes } from '../../../../lib/routes'
import type {
  BondfireDetailData,
  BondfireVideoItem,
  ScrollToIndexFailedInfo,
} from '../_lib/bondfireDetailHelpers'
import { SCREEN_WIDTH } from '../_lib/bondfireDetailHelpers'
import { ThreadBrowser } from './ThreadBrowser'
import { VideoPlayer } from './VideoPlayer'

export function BondfirePlaybackScreen({
  statusBarStyle,
  backgroundColor,
  bondfireId,
  bondfireData,
  canInvite,
  videoItems,
  currentVideoIndex,
  isFocused,
  isAppActive,
  isScrubbing,
  flatListRef,
  onBackPress,
  onVideoComplete,
  onProgress,
  onScrubbingChange,
  onVideoIndexChange,
  initialVideoIndex,
  onScrollToIndexFailed,
}: {
  statusBarStyle: StatusBarStyle
  backgroundColor: string
  bondfireId: Id<'bondfires'>
  bondfireData: BondfireDetailData
  canInvite: boolean
  videoItems: BondfireVideoItem[]
  currentVideoIndex: number
  isFocused: boolean
  isAppActive: boolean
  isScrubbing: boolean
  flatListRef: RefObject<FlatList<BondfireVideoItem> | null>
  onBackPress: () => void
  onVideoComplete: (positionMs?: number, durationMs?: number) => void
  onProgress: (progress: number, positionMs: number, durationMs?: number) => void
  onScrubbingChange: (scrubbing: boolean) => void
  onVideoIndexChange: (index: number) => void
  initialVideoIndex: number
  onScrollToIndexFailed: (info: ScrollToIndexFailedInfo) => void
}) {
  const router = useRouter()
  const overlayState$ = useObservable({
    showSettings: false,
    showNotepad: false,
    isInviteSheetOpen: false,
    suppressPlayback: false,
  })
  const showSettings = useValue(overlayState$.showSettings)
  const showNotepad = useValue(overlayState$.showNotepad)
  const isInviteSheetOpen = useValue(overlayState$.isInviteSheetOpen)
  const suppressPlayback = useValue(overlayState$.suppressPlayback)
  const totalVideos = videoItems.length
  const processingResponseCount = bondfireData.processingResponses?.length ?? 0
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        onVideoIndexChange(viewableItems[0].index)
      }
    },
    [onVideoIndexChange],
  )
  const handleRespond = useCallback(() => {
    if (bondfireData.campStatus === 'archived') return
    overlayState$.suppressPlayback.set(true)
    router.push(routes.createRespondTo(bondfireId))
  }, [bondfireData.campStatus, bondfireId, overlayState$, router])

  useEffect(() => {
    if (isFocused) {
      overlayState$.suppressPlayback.set(false)
    }
  }, [isFocused, overlayState$])

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <YStack flex={1} backgroundColor={'$background'}>
        <XStack
          position="absolute"
          top={0}
          left={0}
          right={0}
          zIndex={100}
          paddingTop={50}
          paddingHorizontal={16}
          paddingBottom={12}
        >
          <LinearGradient
            colors={OVERLAY_COLORS.gradientTop}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 100,
            }}
          />
          <XStack flex={1} justifyContent="space-between" alignItems="center">
            <Pressable onPress={onBackPress}>
              <XStack
                paddingHorizontal={12}
                height={40}
                borderRadius={20}
                backgroundColor={OVERLAY_COLORS.pillBackground}
                alignItems="center"
                gap={6}
              >
                <ChevronLeft size={22} color={OVERLAY_COLORS.textPrimary} />
                <Text fontSize={13} fontWeight="700" color={OVERLAY_COLORS.textPrimary}>
                  Campground
                </Text>
              </XStack>
            </Pressable>

            <XStack gap={8}>
              <Pressable
                onPress={() => overlayState$.showSettings.set(!overlayState$.showSettings.get())}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={showSettings ? '$primary' : OVERLAY_COLORS.pillBackground}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Settings size={22} color={OVERLAY_COLORS.textPrimary} />
                </YStack>
              </Pressable>
              <Pressable
                onPress={() => overlayState$.showNotepad.set(!overlayState$.showNotepad.get())}
              >
                <YStack
                  width={40}
                  height={40}
                  borderRadius={20}
                  backgroundColor={showNotepad ? '$primary' : OVERLAY_COLORS.pillBackground}
                  alignItems="center"
                  justifyContent="center"
                >
                  <FileText size={22} color={OVERLAY_COLORS.textPrimary} />
                </YStack>
              </Pressable>
            </XStack>
          </XStack>
        </XStack>

        <FlatList
          key={bondfireId}
          ref={flatListRef}
          data={videoItems}
          keyExtractor={(item) => item.key}
          renderItem={({ item, index }) => (
            <VideoPlayer
              bondfireId={item.bondfireId}
              bondfireVideoId={item.bondfireVideoId}
              videoUrl={item.url}
              captionsUrl={item.captionsUrl}
              videoOwnerId={item.videoOwnerId}
              isActive={index === currentVideoIndex}
              isScreenFocused={isFocused && !suppressPlayback}
              isAppActive={isAppActive}
              onComplete={onVideoComplete}
              onProgress={onProgress}
              onScrubbingChange={onScrubbingChange}
              creatorName={item.creatorName}
              isMainVideo={item.isMainVideo}
              responseIndex={item.responseIndex}
              isLive={item.isLive}
            />
          )}
          horizontal
          pagingEnabled
          scrollEnabled={!isScrubbing}
          showsHorizontalScrollIndicator={false}
          snapToInterval={SCREEN_WIDTH}
          snapToAlignment="start"
          decelerationRate="fast"
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          initialScrollIndex={initialVideoIndex}
          getItemLayout={(_, index) => ({
            length: SCREEN_WIDTH,
            offset: SCREEN_WIDTH * index,
            index,
          })}
          onScrollToIndexFailed={onScrollToIndexFailed}
        />

        {currentVideoIndex < totalVideos - 1 && (
          <YStack
            position="absolute"
            right={8}
            top="50%"
            marginTop={-20}
            opacity={0.6}
            pointerEvents="none"
          >
            <ChevronRight size={32} color={OVERLAY_COLORS.textPrimary} />
          </YStack>
        )}

        <ThreadBrowser
          title={
            // || not ??: an empty-string user title must fall through, matching
            // the Boolean(title) gate the backend uses for aiTitle generation.
            bondfireData.title ||
            bondfireData.aiTitle ||
            `${bondfireData.creatorName ?? 'Anonymous'}'s Bondfire`
          }
          videoItems={videoItems}
          currentVideoIndex={currentVideoIndex}
          participants={bondfireData.participants}
          processingCount={processingResponseCount}
          canRespond={bondfireData.campStatus !== 'archived'}
          canShare={canInvite}
          onSelectVideo={(index) => {
            flatListRef.current?.scrollToIndex({ index, animated: true })
          }}
          onRespond={handleRespond}
          onShare={() => overlayState$.isInviteSheetOpen.set(true)}
        />

        {showSettings && <SettingsPopover onClose={() => overlayState$.showSettings.set(false)} />}
        {showNotepad && <NotepadOverlay onClose={() => overlayState$.showNotepad.set(false)} />}

        <InviteSheet
          mode={bondfireData.personalCampId ? 'personal-bondfire' : 'bondfire'}
          id={bondfireId}
          open={isInviteSheetOpen}
          onClose={() => overlayState$.isInviteSheetOpen.set(false)}
        />
      </YStack>
    </>
  )
}
