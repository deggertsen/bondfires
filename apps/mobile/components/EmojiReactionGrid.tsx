import { Lock } from '@tamagui/lucide-icons'
import { subscriptionActions } from '@bondfires/app'
import { Pressable, View } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'
import { ALL_EMOJIS, FREE_EMOJIS, isFreeEmoji } from '../constants/emojis'

interface EmojiReactionGridProps {
  isPaid: boolean
  recentEmojis: string[]
  onSelect: (emoji: string) => void
  onClose: () => void
}

const EMOJI_BUTTON_SIZE = 36
const EMOJI_FONT_SIZE = 20
const GRID_COLUMNS = 4
const GRID_ROWS = 4
const RECENT_SLOTS = 4
const GAP = 4
const RECENT_COLUMN_GAP = 6

export function EmojiReactionGrid({ isPaid, recentEmojis, onSelect }: EmojiReactionGridProps) {
  const handleEmojiPress = (emoji: string) => {
    if (!isPaid && !isFreeEmoji(emoji)) {
      // Locked emoji — show paywall
      subscriptionActions.showPaywall()
      return
    }
    onSelect(emoji)
  }

  // Build the recent column: for free users, always show FREE_EMOJIS (padded to 4 slots)
  // For paid users, show the provided recentEmojis (padded to 4 slots)
  const recentColumn = isPaid
    ? [
        ...recentEmojis.slice(0, RECENT_SLOTS),
        ...Array(RECENT_SLOTS - Math.min(recentEmojis.length, RECENT_SLOTS)).fill(null),
      ]
    : [
        ...FREE_EMOJIS.slice(0, RECENT_SLOTS),
        ...Array(RECENT_SLOTS - FREE_EMOJIS.length).fill(null),
      ]

  return (
    <View
      style={{
        position: 'absolute',
        right: 0,
        bottom: 52,
        zIndex: 10,
      }}
    >
      <XStack
        gap={RECENT_COLUMN_GAP}
        padding={8}
        borderRadius={16}
        backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
        opacity={0.85}
      >
        {/* Main 4x4 grid */}
        <YStack gap={GAP}>
          {Array.from({ length: GRID_ROWS }, (_, row) => (
            <XStack key={row} gap={GAP}>
              {Array.from({ length: GRID_COLUMNS }, (_, col) => {
                const index = row * GRID_COLUMNS + col
                const emoji = ALL_EMOJIS[index]
                const locked = !isPaid && !isFreeEmoji(emoji)
                return (
                  <Pressable
                    key={index}
                    onPress={() => handleEmojiPress(emoji)}
                    style={{
                      width: EMOJI_BUTTON_SIZE,
                      height: EMOJI_BUTTON_SIZE,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <YStack
                      width={EMOJI_BUTTON_SIZE}
                      height={EMOJI_BUTTON_SIZE}
                      alignItems="center"
                      justifyContent="center"
                      opacity={locked ? 0.4 : 1}
                    >
                      <Text fontSize={EMOJI_FONT_SIZE}>{emoji}</Text>
                      {locked && (
                        <YStack
                          position="absolute"
                          bottom={2}
                          right={2}
                          width={12}
                          height={12}
                          borderRadius={6}
                          backgroundColor="rgba(0,0,0,0.6)"
                          alignItems="center"
                          justifyContent="center"
                        >
                          <Lock size={8} color={VIDEO_OVERLAY_COLORS.textPrimary} />
                        </YStack>
                      )}
                    </YStack>
                  </Pressable>
                )
              })}
            </XStack>
          ))}
        </YStack>

        {/* Recent emojis column */}
        <YStack gap={GAP} width={EMOJI_BUTTON_SIZE}>
          {recentColumn.map((emoji, i) => (
            <YStack
              key={i}
              width={EMOJI_BUTTON_SIZE}
              height={EMOJI_BUTTON_SIZE}
              alignItems="center"
              justifyContent="center"
            >
              {emoji ? (
                <Pressable
                  onPress={() => handleEmojiPress(emoji)}
                  style={{
                    width: EMOJI_BUTTON_SIZE,
                    height: EMOJI_BUTTON_SIZE,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text fontSize={EMOJI_FONT_SIZE}>{emoji}</Text>
                </Pressable>
              ) : null}
            </YStack>
          ))}
        </YStack>
      </XStack>
    </View>
  )
}