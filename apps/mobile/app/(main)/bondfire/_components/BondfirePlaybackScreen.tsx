import { Button, Text } from '@bondfires/ui'
import { ChevronLeft, ChevronRight, FileText, Flame, Settings } from '@tamagui/lucide-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { Stack } from 'expo-router'
import type { RefObject } from 'react'
import type { StatusBarStyle, ViewToken } from 'react-native'
import { FlatList, Pressable, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import { InviteSheet } from '../../../../components/InviteSheet'
import { NotepadOverlay } from '../../../../components/NotepadOverlay'
import { SettingsPopover } from '../../../../components/SettingsPopover'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import type {
  BondfireDetailData,
  BondfireVideoItem,
  ScrollToIndexFailedInfo,
} from '../_lib/bondfireDetailHelpers'
import { SCREEN_WIDTH } from '../_lib/bondfireDetailHelpers'
import { VideoPlayer } from './VideoPlayer'

type CampContext =
  | {
      canInvite?: boolean
    }
  | null
  | undefined

export function BondfirePlaybackScreen({
  statusBarStyle,
  backgroundColor,
  bondfireId,
  bondfireData,
  campContext,
  videoItems,
  currentVideoIndex,
  totalVideos,
  processingResponseCount,
  isFocused,
  isAppActive,
  isScrubbing,
  showSettings,
  showNotepad,
  isInviteSheetOpen,
  flatListRef,
  onBackPress,
  onToggleSettings,
  onToggleNotepad,
  onCloseSettings,
  onCloseNotepad,
  onOpenInviteSheet,
  onCloseInviteSheet,
  onRespond,
  onVideoComplete,
  onProgress,
  onScrubbingChange,
  onViewableItemsChanged,
  viewabilityConfig,
  initialVideoIndex,
  onScrollToIndexFailed,
}: {
  statusBarStyle: StatusBarStyle
  backgroundColor: string
  bondfireId: Id<'bondfires'>
  bondfireData: BondfireDetailData
  campContext: CampContext
  videoItems: BondfireVideoItem[]
  currentVideoIndex: number
  totalVideos: number
  processingResponseCount: number
  isFocused: boolean
  isAppActive: boolean
  isScrubbing: boolean
  showSettings: boolean
  showNotepad: boolean
  isInviteSheetOpen: boolean
  flatListRef: RefObject<FlatList<BondfireVideoItem> | null>
  onBackPress: () => void
  onToggleSettings: () => void
  onToggleNotepad: () => void
  onCloseSettings: () => void
  onCloseNotepad: () => void
  onOpenInviteSheet: () => void
  onCloseInviteSheet: () => void
  onRespond: () => void
  onVideoComplete: () => void
  onProgress: (progress: number) => void
  onScrubbingChange: (scrubbing: boolean) => void
  onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => void
  viewabilityConfig: { itemVisiblePercentThreshold: number }
  initialVideoIndex: number
  onScrollToIndexFailed: (info: ScrollToIndexFailedInfo) => void
}) {
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

            <YStack alignItems="center">
              <Text fontWeight="600" fontSize={16} color={OVERLAY_COLORS.textPrimary}>
                {currentVideoIndex + 1} / {totalVideos}
              </Text>
              <Text fontSize={12} color={OVERLAY_COLORS.textSecondary}>
                {processingResponseCount > 0
                  ? `${processingResponseCount} ${processingResponseCount === 1 ? 'response' : 'responses'} processing...`
                  : 'Swipe for responses'}
              </Text>
            </YStack>

            <XStack gap={8}>
              <Pressable onPress={onToggleSettings}>
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
              <Pressable onPress={onToggleNotepad}>
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
              videoOwnerId={item.videoOwnerId}
              isActive={index === currentVideoIndex}
              isScreenFocused={isFocused}
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

        {bondfireData.campStatus !== 'archived' ? (
          <YStack
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            paddingHorizontal={20}
            paddingBottom={28}
            paddingTop={16}
          >
            <LinearGradient
              colors={OVERLAY_COLORS.gradientBottomThin}
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 120,
              }}
            />
            {campContext?.canInvite ? (
              <XStack gap={12}>
                <Button
                  variant="outline"
                  size="$lg"
                  flex={1}
                  onPress={onOpenInviteSheet}
                  borderColor={OVERLAY_COLORS.textPrimary}
                >
                  <Text color={OVERLAY_COLORS.textPrimary} fontWeight="700">
                    Share Bondfire
                  </Text>
                </Button>
                <Button variant="primary" size="$lg" flex={1} onPress={onRespond}>
                  <Flame size={18} color={OVERLAY_COLORS.textPrimary} />
                  <Text color={OVERLAY_COLORS.textPrimary} fontWeight="700">
                    Respond
                  </Text>
                </Button>
              </XStack>
            ) : (
              <Button variant="primary" size="$lg" onPress={onRespond}>
                <Flame size={20} color={OVERLAY_COLORS.textPrimary} />
                <Text color={OVERLAY_COLORS.textPrimary}>Add Your Response</Text>
              </Button>
            )}
          </YStack>
        ) : null}

        <XStack position="absolute" bottom={100} left={0} right={0} justifyContent="center" gap={8}>
          {videoItems.map((item, index) => (
            <Pressable
              key={item.key}
              onPress={() => {
                flatListRef.current?.scrollToIndex({ index, animated: true })
              }}
            >
              <YStack
                width={index === currentVideoIndex ? 24 : 8}
                height={8}
                borderRadius={4}
                backgroundColor={
                  index === currentVideoIndex ? '$primary' : OVERLAY_COLORS.dotInactive
                }
              />
            </Pressable>
          ))}
        </XStack>

        {showSettings && <SettingsPopover onClose={onCloseSettings} />}
        {showNotepad && <NotepadOverlay onClose={onCloseNotepad} />}

        <InviteSheet
          mode="bondfire"
          id={bondfireId}
          open={isInviteSheetOpen}
          onClose={onCloseInviteSheet}
        />
      </YStack>
    </>
  )
}
