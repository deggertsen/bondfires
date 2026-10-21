import { useCallback, useEffect, useRef, useState } from 'react'
import { Dimensions, View } from 'react-native'
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { XStack, YStack } from 'tamagui'
import { buildReactionFlights, type ReactionChipCount } from './reactionFlights'
import { Text } from './Text'

export type { ReactionChipCount } from './reactionFlights'

export type ReactionChipProps = {
  /** Per-emoji counts, highest first. Only the first three are shown. */
  counts?: ReactionChipCount[]
  total?: number
  /** Someone else reacted since the viewer last opened the thread. */
  isNew?: boolean
  size?: 'md' | 'sm'
  /**
   * Asked when the chip is on screen, and again when its total grows while on
   * screen. Return the total this device last showed (0 when never) to play
   * the fly-in from there, or null to render settled.
   */
  onRequestFlyIn?: (total: number) => number | null
  /**
   * Whether the row is on screen, from the list's viewability. Pass it for
   * FlatList rows, which mount ahead of the viewport; when omitted, the chip
   * measures itself on layout instead.
   */
  isVisible?: boolean
}

const MAX_SHOWN_EMOJIS = 3
const FLIGHT_MS = 1200
const FLIGHT_STAGGER_MS = 100
// Where each flying emoji starts, relative to the chip's center. Mostly from
// across the row and within its height, so a clipping row still shows them.
const FLIGHT_STARTS: ReadonlyArray<readonly [number, number]> = [
  [-170, -22],
  [-100, 26],
  [-60, -30],
  [-210, 12],
  [40, -26],
  [-135, -4],
]

const SIZES = {
  md: { height: 22, paddingX: 8, emoji: 12, count: 12 },
  sm: { height: 18, paddingX: 6, emoji: 10, count: 11 },
} as const

type Flight = { id: string; emoji: string; start: readonly [number, number]; delay: number }

function FlyingEmoji({
  emoji,
  start,
  delay,
}: {
  emoji: string
  start: readonly [number, number]
  delay: number
}) {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: FLIGHT_MS, easing: Easing.inOut(Easing.cubic) }),
    )
  }, [delay, progress])

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.12, 0.88, 1], [0, 1, 1, 0]),
    transform: [
      { translateX: start[0] * (1 - progress.value) },
      { translateY: start[1] * (1 - progress.value) },
      { scale: interpolate(progress.value, [0, 1], [1.4, 0.45]) },
    ],
  }))

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 20,
          height: 20,
          marginLeft: -10,
          marginTop: -10,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Text fontSize={16} lineHeight={20}>
        {emoji}
      </Text>
    </Animated.View>
  )
}

function isOnScreen(x: number, y: number, width: number, height: number) {
  const window = Dimensions.get('window')
  return width > 0 && y + height > 0 && y < window.height && x < window.width && x + width > 0
}

type ChipBodyProps = {
  counts: ReactionChipCount[]
  count: number
  isNew: boolean
  size: 'md' | 'sm'
}

function ReactionChipBody({ counts, count, isNew, size }: ChipBodyProps) {
  const metrics = SIZES[size]
  return (
    <XStack
      height={metrics.height}
      paddingHorizontal={metrics.paddingX}
      borderRadius={metrics.height / 2}
      borderWidth={1}
      borderColor={isNew ? '$secondary' : '$borderColor'}
      backgroundColor="$backgroundHover"
      alignItems="center"
      gap={4}
      overflow="hidden"
    >
      {isNew ? (
        <YStack
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          backgroundColor="$secondary"
          opacity={0.14}
        />
      ) : null}
      <Text fontSize={metrics.emoji} lineHeight={metrics.height - 4}>
        {counts
          .slice(0, MAX_SHOWN_EMOJIS)
          .map((entry) => entry.emoji)
          .join('')}
      </Text>
      <Text
        fontSize={metrics.count}
        fontWeight="800"
        color={isNew ? '$secondary' : '$color'}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {count}
      </Text>
    </XStack>
  )
}

function chipLabel(total: number, isNew: boolean) {
  return `${total} ${total === 1 ? 'reaction' : 'reactions'}${isNew ? ', new' : ''}`
}

function AnimatedReactionChip({
  counts,
  total,
  isNew,
  size,
  onRequestFlyIn,
  isVisible,
}: Required<Omit<ReactionChipProps, 'onRequestFlyIn' | 'isVisible'>> &
  Pick<ReactionChipProps, 'onRequestFlyIn' | 'isVisible'>) {
  const reduceMotion = useReducedMotion()
  const ref = useRef<View>(null)
  const requestedTotal = useRef<number | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const playCount = useRef(0)
  const [shownCount, setShownCount] = useState<number | null>(null)
  const [flights, setFlights] = useState<Flight[]>([])
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  const chipStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }))

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer)
    },
    [],
  )

  const play = useCallback(
    (fromTotal: number) => {
      const emojis = buildReactionFlights(counts, total - fromTotal)
      if (emojis.length === 0) return
      for (const timer of timers.current) clearTimeout(timer)
      timers.current = []

      const firstLand = FLIGHT_MS
      const lastLand = FLIGHT_MS + FLIGHT_STAGGER_MS * (emojis.length - 1)
      playCount.current += 1
      const run = playCount.current
      setFlights(
        emojis.map((emoji, index) => ({
          id: `${run}-${index}`,
          emoji,
          start: FLIGHT_STARTS[index % FLIGHT_STARTS.length],
          delay: index * FLIGHT_STAGGER_MS,
        })),
      )

      // The chip waits dimmed, wakes as the first emoji lands, and bumps on the last.
      opacity.value = 0.35
      scale.value = 0.82
      opacity.value = withDelay(firstLand - 80, withTiming(1, { duration: 160 }))
      scale.value = withSequence(
        withDelay(firstLand - 80, withTiming(1, { duration: 160 })),
        withDelay(Math.max(0, lastLand - firstLand - 160), withTiming(1.18, { duration: 120 })),
        withTiming(1, { duration: 220, easing: Easing.out(Easing.back(2)) }),
      )

      // The count ticks up in thirds as the emojis land.
      const steps = [1 / 3, 2 / 3, 1].map((fraction) =>
        Math.max(fromTotal + 1, Math.round(fromTotal + (total - fromTotal) * fraction)),
      )
      setShownCount(fromTotal)
      steps.forEach((value, index) => {
        const at = firstLand + ((lastLand - firstLand) * index) / Math.max(1, steps.length - 1)
        timers.current.push(setTimeout(() => setShownCount(value), at))
      })
      timers.current.push(
        setTimeout(() => {
          setShownCount(null)
          setFlights([])
        }, lastLand + 120),
      )
    },
    [counts, total, opacity, scale],
  )

  const maybePlay = useCallback(() => {
    if (!onRequestFlyIn || reduceMotion || total <= 0) return
    if (requestedTotal.current !== null && total <= requestedTotal.current) return
    const claim = () => {
      requestedTotal.current = total
      const fromTotal = onRequestFlyIn(total)
      if (fromTotal !== null && fromTotal < total) play(fromTotal)
    }
    if (isVisible !== undefined) {
      if (isVisible) claim()
      return
    }
    ref.current?.measureInWindow((x, y, width, height) => {
      if (isOnScreen(x, y, width, height)) claim()
    })
  }, [isVisible, onRequestFlyIn, play, reduceMotion, total])

  // Ask again when the row scrolls into view or its total grows (a live
  // reaction). A chip that was off screen at layout keeps asking until it is
  // seen; one that already played asks only when its total grows past that.
  const maybePlayRef = useRef(maybePlay)
  maybePlayRef.current = maybePlay
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-ask only when these change
  useEffect(() => {
    maybePlayRef.current()
  }, [total, isVisible])

  return (
    <View
      ref={ref}
      onLayout={maybePlay}
      accessible
      accessibilityLabel={chipLabel(total, isNew)}
      style={{ flexShrink: 0 }}
    >
      <Animated.View style={chipStyle}>
        <ReactionChipBody counts={counts} count={shownCount ?? total} isNew={isNew} size={size} />
      </Animated.View>
      {flights.map((flight) => (
        <FlyingEmoji
          key={flight.id}
          emoji={flight.emoji}
          start={flight.start}
          delay={flight.delay}
        />
      ))}
    </View>
  )
}

/**
 * The reaction summary pill on Bondfire rows and thread-sheet rows: up to
 * three emojis and the total. New reactions tint it with the secondary color.
 * Renders nothing when there are no reactions.
 *
 * Only a chip that has been offered a fly-in (`onRequestFlyIn`) pays for the
 * Reanimated hooks and the on-screen measurement; every other chip is a plain
 * view. Once offered, it stays animated so a fly-in is never cut off when the
 * offer is withdrawn on the next render.
 */
export function ReactionChip({
  counts = [],
  total = 0,
  isNew = false,
  size = 'md',
  onRequestFlyIn,
  isVisible,
}: ReactionChipProps) {
  const animated = useRef(false)
  if (onRequestFlyIn) animated.current = true

  if (total <= 0) return null

  if (animated.current) {
    return (
      <AnimatedReactionChip
        counts={counts}
        total={total}
        isNew={isNew}
        size={size}
        onRequestFlyIn={onRequestFlyIn}
        isVisible={isVisible}
      />
    )
  }

  return (
    <View accessible accessibilityLabel={chipLabel(total, isNew)} style={{ flexShrink: 0 }}>
      <ReactionChipBody counts={counts} count={total} isNew={isNew} size={size} />
    </View>
  )
}
