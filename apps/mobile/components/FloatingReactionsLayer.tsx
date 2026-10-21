import type { Observable } from '@legendapp/state'
import { useObservable, useObserveEffect, useValue } from '@legendapp/state/react'
import { useEffect, useRef } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import type { ActiveReaction } from './ViewerPresenceStack'

const FLOAT_DURATION_MS = 3000
const FLOAT_RISE = 300
/** Floats on screen at once. A reaction that arrives while full is skipped. */
const MAX_FLOATS = 8
const EMOJI_SIZE = 26

type Float = { key: string; emoji: string; sway: number; size: number }

let nextFloatKey = 0

function FloatingEmoji({ float, onDone }: { float: Float; onDone: (key: string) => void }) {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withTiming(
      1,
      { duration: FLOAT_DURATION_MS, easing: Easing.out(Easing.quad) },
      (finished) => {
        if (finished) runOnJS(onDone)(float.key)
      },
    )
  }, [float.key, onDone, progress])

  const style = useAnimatedStyle(() => {
    const p = progress.value
    return {
      opacity: interpolate(p, [0, 0.06, 0.7, 1], [0, 1, 0.9, 0]),
      transform: [
        { translateY: -FLOAT_RISE * p },
        // One slow S-curve across the rise; `sway` picks its direction and width.
        { translateX: float.sway * Math.sin(p * Math.PI * 2) },
        { scale: interpolate(p, [0, 0.06, 0.25, 1], [0.3, 1.15, 1, 0.85]) },
      ],
    }
  })

  return (
    <Animated.View style={[styles.float, style]}>
      <Text style={{ fontSize: float.size }}>{float.emoji}</Text>
    </Animated.View>
  )
}

/**
 * Each replayed (or freshly sent) reaction also floats up the right edge, on
 * top of the avatar replay in ViewerPresenceStack. Fed by the same
 * activeReactions list; a reaction id floats once per appearance in it.
 */
export function FloatingReactionsLayer({
  activeReactions$,
  bottom,
  right,
}: {
  activeReactions$: Observable<ActiveReaction[]>
  bottom: number
  right: number
}) {
  const reduceMotion = useReducedMotion()
  const reduceMotionRef = useRef(reduceMotion)
  reduceMotionRef.current = reduceMotion
  const floats$ = useObservable<Float[]>([])
  const floats = useValue(floats$)
  // Ids in activeReactions at the last check. Diffing against this (rather than
  // a set of every id ever seen) lets a reaction float again after a seek back
  // re-adds it.
  const previousIdsRef = useRef<Set<string>>(new Set())

  useObserveEffect(() => {
    const reactions = activeReactions$.get()
    const previousIds = previousIdsRef.current
    previousIdsRef.current = new Set(reactions.map((reaction) => reaction.id))
    if (reduceMotionRef.current) return

    const added = reactions.filter((reaction) => !previousIds.has(reaction.id))
    if (added.length === 0) return
    const current = floats$.peek()
    const room = Math.max(0, MAX_FLOATS - current.length)
    if (room === 0) return
    floats$.set([
      ...current,
      ...added.slice(0, room).map((reaction) => {
        const key = `${reaction.id}-${nextFloatKey++}`
        const direction = nextFloatKey % 2 === 0 ? 1 : -1
        return {
          key,
          emoji: reaction.emoji,
          sway: direction * (8 + (nextFloatKey % 3) * 4),
          size: nextFloatKey % 3 === 0 ? EMOJI_SIZE - 6 : EMOJI_SIZE,
        }
      }),
    ])
  })

  const handleDone = useRef((key: string) => {
    floats$.set(floats$.peek().filter((float) => float.key !== key))
  }).current

  if (floats.length === 0) return null

  return (
    <View pointerEvents="none" style={[styles.anchor, { bottom, right }]}>
      {floats.map((float) => (
        <FloatingEmoji key={float.key} float={float} onDone={handleDone} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    width: 44,
    height: 0,
    zIndex: 3,
  },
  float: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
})
