import { useCallback, useMemo, useRef } from 'react'
import {
  Animated,
  type GestureResponderEvent,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
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
  /** Actions revealed by swiping LEFT (destructive / admin actions) */
  actions: SwipeAction[]
  /** Actions revealed by swiping RIGHT (constructive actions like Edit) */
  rightActions?: SwipeAction[]
  /** Width of the left revealed action area (default: actions.length * 72) */
  actionWidth?: number
  /** Width of the right revealed action area (default: rightActions.length * 72) */
  rightActionWidth?: number
  /** Threshold to trigger snap-open (default: 0.35) */
  openThreshold?: number
  style?: StyleProp<ViewStyle>
}

/**
 * A swipeable row that reveals action buttons when swiped.
 *
 * - Swipe LEFT to reveal `actions` (e.g. Delete, Pin, Report)
 * - Swipe RIGHT to reveal `rightActions` (e.g. Edit)
 *
 * Uses React Native's PanResponder + Animated — no extra deps.
 */
export function SwipeableRow({
  children,
  actions,
  rightActions,
  actionWidth,
  rightActionWidth,
  openThreshold = 0.35,
  style,
}: Props) {
  const leftPanelWidth = actionWidth ?? actions.length * 72
  const rightPanelWidth = rightActionWidth ?? (rightActions?.length ?? 0) * 72
  const translateX = useRef(new Animated.Value(0)).current
  const currentOffset = useRef(0)

  const clampTranslateX = useCallback(
    (value: number) => Math.max(-leftPanelWidth, Math.min(rightPanelWidth, value)),
    [leftPanelWidth, rightPanelWidth],
  )

  const snapTo = useCallback(
    (toValue: number) => {
      currentOffset.current = toValue
      Animated.spring(translateX, {
        toValue,
        useNativeDriver: true,
        tension: 60,
        friction: 10,
      }).start()
    },
    [translateX],
  )

  const close = useCallback(() => {
    snapTo(0)
  }, [snapTo])

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
          // Only capture horizontal swipes (not vertical scrolls)
          return (
            (leftPanelWidth > 0 || rightPanelWidth > 0) &&
            Math.abs(gs.dx) > 10 &&
            Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5
          )
        },
        onPanResponderMove: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
          const next = clampTranslateX(currentOffset.current + gs.dx)
          translateX.setValue(next)
        },
        onPanResponderRelease: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
          const dragged = clampTranslateX(currentOffset.current + gs.dx)

          // Left-swipe snap: open if dragged past threshold
          const leftThreshold = -leftPanelWidth * openThreshold
          if (dragged < leftThreshold) {
            snapTo(-leftPanelWidth)
            return
          }

          // Right-swipe snap: open if dragged past threshold
          const rightThreshold = rightPanelWidth * openThreshold
          if (dragged > rightThreshold) {
            snapTo(rightPanelWidth)
            return
          }

          snapTo(0)
        },
        onPanResponderTerminate: close,
        onPanResponderTerminationRequest: () => true,
      }),
    [clampTranslateX, leftPanelWidth, rightPanelWidth, close, openThreshold, snapTo, translateX],
  )

  return (
    <YStack style={style}>
      {/* Left action buttons — revealed when swiping left (negative translateX) */}
      {leftPanelWidth > 0 && (
        <XStack position="absolute" right={0} top={0} bottom={0} width={leftPanelWidth}>
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
                backgroundColor={action.backgroundColor ?? '$backgroundHover'}
                paddingHorizontal={8}
              >
                <Text
                  fontSize={12}
                  fontWeight="800"
                  color={action.color ?? '$color'}
                  textAlign="center"
                >
                  {action.label}
                </Text>
              </YStack>
            </Pressable>
          ))}
        </XStack>
      )}

      {/* Right action buttons — revealed when swiping right (positive translateX) */}
      {rightPanelWidth > 0 && rightActions && (
        <XStack position="absolute" left={0} top={0} bottom={0} width={rightPanelWidth}>
          {rightActions.map((action) => (
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
                backgroundColor={action.backgroundColor ?? '$backgroundHover'}
                paddingHorizontal={8}
              >
                <Text
                  fontSize={12}
                  fontWeight="800"
                  color={action.color ?? '$color'}
                  textAlign="center"
                >
                  {action.label}
                </Text>
              </YStack>
            </Pressable>
          ))}
        </XStack>
      )}

      {/* Foreground content — slides to reveal actions on either side */}
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
