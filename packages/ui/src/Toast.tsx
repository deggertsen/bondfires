/**
 * Global toast notification component.
 *
 * Renders a controlled stacked list of toast messages at the top of the
 * screen. Error-level toasts show a reference ID so users can screenshot
 * and share with support.
 */

import { useCallback, useEffect, useRef } from 'react'
import { Animated, Pressable, View } from 'react-native'
import { Text as TamaguiText, View as TamaguiView } from 'tamagui'

export type ToastType = 'error' | 'warn' | 'info' | 'success'

export interface ToastEntry {
  id: string
  type: ToastType
  message: string
  referenceId?: string
}

// ---------------------------------------------------------------------------
// Styling per toast type
// ---------------------------------------------------------------------------

// Toast backgrounds are fixed overlays, so text stays fixed white for contrast in both themes.
const TOAST_TEXT_COLOR = '#FFFFFF'
const TOAST_MUTED_TEXT_COLOR = 'rgba(255, 255, 255, 0.82)'

const TYPE_STYLES: Record<ToastType, { bg: string; border: string; text: string }> = {
  error: {
    bg: 'rgba(239, 68, 68, 0.95)',
    border: '$error',
    text: TOAST_TEXT_COLOR,
  },
  warn: {
    bg: 'rgba(245, 158, 11, 0.95)',
    border: '$warning',
    text: TOAST_TEXT_COLOR,
  },
  info: {
    bg: 'rgba(156, 163, 175, 0.95)',
    border: '$placeholderColor',
    text: TOAST_TEXT_COLOR,
  },
  success: {
    bg: 'rgba(34, 197, 94, 0.95)',
    border: '$success',
    text: TOAST_TEXT_COLOR,
  },
}

// ---------------------------------------------------------------------------
// Single toast item (animated enter/exit)
// ---------------------------------------------------------------------------

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: string) => void }) {
  const opacity = useRef(new Animated.Value(0)).current
  const translateY = useRef(new Animated.Value(-20)).current

  const styles = TYPE_STYLES[entry.type]

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start()
  }, [opacity, translateY])

  const handleDismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: -20, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      onDismiss(entry.id)
    })
  }, [entry.id, onDismiss, opacity, translateY])

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }} pointerEvents="auto">
      <Pressable onPress={handleDismiss}>
        <TamaguiView
          backgroundColor={styles.bg}
          borderWidth={1}
          borderColor={styles.border}
          borderRadius={12}
          paddingVertical={10}
          paddingHorizontal={14}
          gap={4}
          style={{
            shadowColor: 'rgba(0,0,0,0.3)',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 6,
            elevation: 4,
          }}
        >
          <TamaguiView flexDirection="row" alignItems="center" justifyContent="space-between">
            <TamaguiView flex={1} gap={2}>
              <TamaguiText
                fontSize={14}
                fontWeight="600"
                color={styles.text}
                lineHeight={18}
                numberOfLines={2}
              >
                {entry.message}
              </TamaguiText>
              {entry.referenceId ? (
                <TamaguiText fontSize={11} color={TOAST_MUTED_TEXT_COLOR} lineHeight={14}>
                  Ref: {entry.referenceId}
                </TamaguiText>
              ) : null}
            </TamaguiView>
            <Pressable onPress={handleDismiss} style={{ marginLeft: 8, padding: 4 }}>
              <TamaguiText fontSize={16} color={TOAST_MUTED_TEXT_COLOR}>
                ✕
              </TamaguiText>
            </Pressable>
          </TamaguiView>
        </TamaguiView>
      </Pressable>
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// Container — renders all active toasts
// ---------------------------------------------------------------------------

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 60,
        left: 12,
        right: 12,
        zIndex: 9999,
        gap: 8,
      }}
    >
      {toasts.map((entry) => (
        <ToastItem key={entry.id} entry={entry} onDismiss={onDismiss} />
      ))}
    </View>
  )
}
