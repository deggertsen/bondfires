import { bondfireColors } from '@bondfires/config'
import { useRef, useCallback } from 'react'
import {
  Animated,
  PanResponder,
  Pressable,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { XStack, YStack } from 'tamagui'
import { Text } from './Text'

export type SwipeAction = {
  key: string
  label: string
  color?: string
  backgroundColor?: string
  onPress: () => void
}

type Props = {
  children: React.ReactNode
  actions: SwipeAction[]
  /** Width of the revealed action area (default: actions.length * 72) */
  actionWidth?: number
  /** Threshold to trigger snap-open (default: 0.35) */
  openThreshold?: number
  style?: StyleProp<ViewStyle>
}

/**
 * A swipeable row that reveals action buttons when swiped left.
 * Uses React Native's PanResponder + Animated — no extra deps beyond reanimated.
 *
 * Designed for list items where you want a Marco Polo-style
 * "swipe left to reveal menu" UX.
 */
export function SwipeableRow({
  children,
  actions,
  actionWidth,
  openThreshold = 0.35,
  style,
}: Props) {
  const actionPanelWidth = actionWidth ?? actions.length * 72
  const translateX = useRef(new Animated.Value(0)).current
  const isOpen = useRef(false)
  const currentOffset = useRef(0)

  const snapTo = useCallback(
    (toValue: number) => {
      currentOffset.current = toValue
      Animated.spring(translateX, {
        toValue,
        useNativeDriver: true,
        tension: 60,
        friction: 10,
      }).start()
      isOpen.current = toValue !== 0
    },
    [translateX],
  )

  const close = useCallback(() => {
    snapTo(0)
  }, [snapTo])

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (
        _: GestureResponderEvent,
        gs: PanResponderGestureState,
      ) => {
        // Only capture horizontal swipes (not vertical scrolls)
        return Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5
      },
      onPanResponderMove: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
        const offset = currentOffset.current
        // Only allow left swipe (negative dx), clamp to range
        const next = Math.min(0, Math.max(-actionPanelWidth, offset + gs.dx))
        translateX.setValue(next)
      },
      onPanResponderRelease: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
        const offset = currentOffset.current
        const dragged = offset + gs.dx
        const threshold = -actionPanelWidth * openThreshold

        if (dragged < threshold) {
          snapTo(-actionPanelWidth)
        } else {
          snapTo(0)
        }
      },
    }),
  ).current

  return (
    <YStack style={style}>
      {/* Action buttons — positioned absolutely behind the row */}
      <XStack
        position="absolute"
        right={0}
        top={0}
        bottom={0}
        width={actionPanelWidth}
      >
        {actions.map((action) => (
          <Pressable
            key={action.key}
            onPress={() => {
              action.onPress()
              close()
            }}
            style={({ pressed }) => ({
              flex: 1,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <YStack
              flex={1}
              alignItems="center"
              justifyContent="center"
              backgroundColor={
                action.backgroundColor ?? bondfireColors.gunmetal
              }
              paddingHorizontal={8}
            >
              <Text
                fontSize={12}
                fontWeight="800"
                color={action.color ?? bondfireColors.whiteSmoke}
                textAlign="center"
              >
                {action.label}
              </Text>
            </YStack>
          </Pressable>
        ))}
      </XStack>

      {/* Foreground content — slides left to reveal actions */}
      <Animated.View
        style={{
          transform: [{ translateX }],
        }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </YStack>
  )
}
