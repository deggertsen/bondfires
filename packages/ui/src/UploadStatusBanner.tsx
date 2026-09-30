import { AlertTriangle, CheckCircle2, CloudUpload, RefreshCw, WifiOff } from '@tamagui/lucide-icons'
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, type LayoutChangeEvent, Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { Spinner } from './Spinner'
import { Text } from './Text'

export type UploadStatusBannerTone = 'progress' | 'warning' | 'error' | 'success'
export type UploadStatusBannerIcon = 'upload' | 'offline' | 'retry' | 'failed' | 'done'

export interface UploadStatusBannerProps {
  tone: UploadStatusBannerTone
  icon: UploadStatusBannerIcon
  title: string
  message: string
  /** 0–100 draws a determinate bar and a %, 'indeterminate' an animated bar. */
  progress?: number | 'indeterminate'
  /** When set, the whole strip is tappable and shows this as its button. */
  actionLabel?: string
  onAction?: () => void
  /** Status-bar inset; the banner owns that area while visible. */
  topInset: number
  onLayout?: (event: LayoutChangeEvent) => void
}

const TONE_COLOR = {
  progress: '$primary',
  warning: '$warning',
  error: '$error',
  success: '$success',
} as const

const ICONS = {
  upload: CloudUpload,
  offline: WifiOff,
  retry: RefreshCw,
  failed: AlertTriangle,
  done: CheckCircle2,
} as const

const SEGMENT_FRACTION = 0.35

function IndeterminateBar() {
  const [width, setWidth] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)
  const position = useRef(new Animated.Value(0)).current

  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled)
      })
      .catch(() => {})
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!width || reduceMotion) return
    position.setValue(0)
    const loop = Animated.loop(
      Animated.timing(position, { toValue: 1, duration: 1600, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [position, reduceMotion, width])

  const segment = width * SEGMENT_FRACTION
  const translateX = position.interpolate({
    inputRange: [0, 1],
    outputRange: [-segment, width],
  })

  return (
    <YStack
      position="absolute"
      left={0}
      right={0}
      bottom={0}
      height={2}
      overflow="hidden"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <Animated.View
          style={{ width: segment, height: 2, transform: reduceMotion ? [] : [{ translateX }] }}
        >
          <YStack flex={1} backgroundColor="$primary" />
        </Animated.View>
      ) : null}
    </YStack>
  )
}

/**
 * App-wide, in-flow status strip for uploads that outlive the create flow
 * ("Ember Strip"). Presentational only; the mobile app maps upload state to
 * these props and decides when it is visible.
 */
export function UploadStatusBanner({
  tone,
  icon,
  title,
  message,
  progress,
  actionLabel,
  onAction,
  topInset,
  onLayout,
}: UploadStatusBannerProps) {
  const toneColor = TONE_COLOR[tone]
  const Icon = ICONS[icon]
  const hasAction = Boolean(actionLabel && onAction)
  const percent = typeof progress === 'number' ? progress : undefined

  const content = (
    <XStack
      alignItems="center"
      gap={12}
      paddingLeft={16}
      paddingRight={hasAction ? 10 : 16}
      paddingVertical={10}
      minHeight={64}
    >
      <YStack
        width={34}
        height={34}
        borderRadius={999}
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <YStack position="absolute" fullscreen backgroundColor={toneColor} opacity={0.15} />
        <Icon size={18} color={toneColor} />
      </YStack>

      <YStack flex={1} gap={2}>
        <Text fontSize={14} fontWeight="700" lineHeight={18} numberOfLines={1}>
          {title}
        </Text>
        <Text fontSize={12.5} lineHeight={17} color="$placeholderColor" numberOfLines={2}>
          {message}
        </Text>
      </YStack>

      {hasAction ? (
        <XStack
          height={44}
          paddingHorizontal={16}
          borderRadius={999}
          alignItems="center"
          backgroundColor={tone === 'error' ? '$primary' : 'transparent'}
          borderWidth={tone === 'error' ? 0 : 1}
          borderColor="$borderColor"
        >
          <Text
            fontSize={13}
            fontWeight={tone === 'error' ? '700' : '600'}
            color={tone === 'error' ? '$background' : '$color'}
          >
            {actionLabel}
          </Text>
        </XStack>
      ) : percent !== undefined ? (
        <Text fontSize={13} fontWeight="700" color="$primary">
          {percent}%
        </Text>
      ) : tone === 'progress' ? (
        <Spinner size="small" color="$primary" />
      ) : null}
    </XStack>
  )

  return (
    <YStack
      onLayout={onLayout}
      paddingTop={topInset}
      backgroundColor="$backgroundStrong"
      borderBottomWidth={1}
      borderBottomColor={tone === 'error' ? '$error' : '$borderColor'}
    >
      {tone === 'error' ? (
        <YStack position="absolute" fullscreen backgroundColor="$error" opacity={0.1} />
      ) : null}
      {hasAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${message}`}
          accessibilityHint={actionLabel}
        >
          {content}
        </Pressable>
      ) : (
        <YStack
          accessible
          accessibilityLabel={`${title}. ${message}`}
          accessibilityLiveRegion="polite"
        >
          {content}
        </YStack>
      )}
      {percent !== undefined ? (
        <YStack position="absolute" left={0} bottom={0} height={2} width={`${percent}%`}>
          <YStack flex={1} backgroundColor="$primary" />
        </YStack>
      ) : progress === 'indeterminate' ? (
        <IndeterminateBar />
      ) : null}
    </YStack>
  )
}
