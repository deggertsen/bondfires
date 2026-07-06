import { useCallback, useRef } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable'
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

function ActionPanel({
  actions,
  width,
  onActionDone,
}: {
  actions: SwipeAction[]
  width: number
  onActionDone: () => void
}) {
  return (
    <XStack width={width}>
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
    </XStack>
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

  const close = useCallback(() => {
    swipeableRef.current?.close()
  }, [])

  // ReanimatedSwipeable naming is inverted from ours: its "right actions"
  // are the ones revealed by swiping left, and vice versa.
  const renderRightActions =
    leftPanelWidth > 0
      ? () => <ActionPanel actions={actions} width={leftPanelWidth} onActionDone={close} />
      : undefined
  const renderLeftActions =
    rightPanelWidth > 0 && rightActions
      ? () => <ActionPanel actions={rightActions} width={rightPanelWidth} onActionDone={close} />
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
      containerStyle={style}
    >
      {children}
    </ReanimatedSwipeable>
  )
}
