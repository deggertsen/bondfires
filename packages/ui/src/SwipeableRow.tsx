import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, type StyleProp, StyleSheet, type ViewStyle } from 'react-native'
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated'
import { YStack } from 'tamagui'
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

// At most one row may be open at a time (iOS Mail behavior). Opening a row
// closes the previous one; lists close the open row when scrolling starts.
let openRow: SwipeableMethods | null = null

/**
 * Close the currently open SwipeableRow, if any. Wire this to a list's
 * `onScrollBeginDrag` so scrolling dismisses the revealed actions.
 */
export function closeOpenSwipeableRow() {
  openRow?.close()
  openRow = null
}

function ActionPanel({
  actions,
  width,
  side,
  progress,
  onActionDone,
}: {
  actions: SwipeAction[]
  width: number
  /** Which edge the panel sits on — controls the parallax slide direction */
  side: 'left' | 'right'
  progress: SharedValue<number>
  onActionDone: () => void
}) {
  // Buttons trail the row slightly as it slides, instead of sitting statically.
  const parallax = useAnimatedStyle(() => {
    const remaining = 1 - Math.min(progress.value, 1)
    return {
      transform: [{ translateX: remaining * width * 0.4 * (side === 'right' ? 1 : -1) }],
    }
  })

  return (
    <Animated.View style={[{ width, flexDirection: 'row' }, parallax]}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={() => {
            action.onPress()
            onActionDone()
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
    </Animated.View>
  )
}

/**
 * A swipeable row that reveals action buttons when swiped.
 *
 * - Swipe LEFT to reveal `actions` (e.g. Delete, Pin, Report)
 * - Swipe RIGHT to reveal `rightActions` (e.g. Edit)
 *
 * Built on react-native-gesture-handler's ReanimatedSwipeable. The pan
 * gesture runs natively, so it wins the race against the enclosing
 * scroll view on iOS — a JS PanResponder gets its touches cancelled by
 * UIScrollView before it can claim horizontal swipes.
 *
 * While a row is open, tapping it closes it instead of triggering the
 * row's own press handler.
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
  const swipeableRef = useRef<SwipeableMethods>(null)
  const [isOpen, setIsOpen] = useState(false)

  const close = useCallback(() => {
    swipeableRef.current?.close()
  }, [])

  const handleOpenStartDrag = useCallback(() => {
    // Close any other open row as soon as this one starts revealing.
    if (openRow && openRow !== swipeableRef.current) {
      openRow.close()
      openRow = null
    }
  }, [])

  const handleWillOpen = useCallback(() => {
    if (openRow && openRow !== swipeableRef.current) {
      openRow.close()
    }
    openRow = swipeableRef.current
    setIsOpen(true)
  }, [])

  const handleWillClose = useCallback(() => {
    if (openRow === swipeableRef.current) {
      openRow = null
    }
    setIsOpen(false)
  }, [])

  // FlatList recycling can unmount a row while it is open — drop the stale
  // registry entry so closeOpenSwipeableRow() doesn't call into a dead ref.
  useEffect(() => {
    return () => {
      if (openRow === swipeableRef.current) {
        openRow = null
      }
    }
  }, [])

  // ReanimatedSwipeable naming is inverted from ours: its "right actions"
  // are the ones revealed by swiping left, and vice versa.
  const renderRightActions =
    leftPanelWidth > 0
      ? (progress: SharedValue<number>) => (
          <ActionPanel
            actions={actions}
            width={leftPanelWidth}
            side="right"
            progress={progress}
            onActionDone={close}
          />
        )
      : undefined
  const renderLeftActions =
    rightPanelWidth > 0 && rightActions
      ? (progress: SharedValue<number>) => (
          <ActionPanel
            actions={rightActions}
            width={rightPanelWidth}
            side="left"
            progress={progress}
            onActionDone={close}
          />
        )
      : undefined

  if (!renderRightActions && !renderLeftActions) {
    return <YStack style={style}>{children}</YStack>
  }

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      friction={1}
      overshootLeft={false}
      overshootRight={false}
      leftThreshold={rightPanelWidth * openThreshold}
      rightThreshold={leftPanelWidth * openThreshold}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      onSwipeableOpenStartDrag={handleOpenStartDrag}
      onSwipeableWillOpen={handleWillOpen}
      onSwipeableWillClose={handleWillClose}
      containerStyle={style}
    >
      {children}
      {isOpen && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      )}
    </ReanimatedSwipeable>
  )
}
