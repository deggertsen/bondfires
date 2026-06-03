/**
 * Global toast notification component.
 *
 * Renders a controlled stacked list of toast messages at the top of the
 * screen. Error-level toasts show a reference ID so users can screenshot
 * and share with support.
 */

import { bondfireColors } from '@bondfires/config'
import { useCallback, useEffect, useRef } from 'react'
import { Animated, Pressable, Text, View } from 'react-native'

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

const TYPE_STYLES: Record<ToastType, { bg: string; border: string; text: string }> = {
  error: {
    bg: 'rgba(239, 68, 68, 0.15)',
    border: bondfireColors.error,
    text: bondfireColors.whiteSmoke,
  },
  warn: {
    bg: 'rgba(245, 158, 11, 0.15)',
    border: bondfireColors.warning,
    text: bondfireColors.whiteSmoke,
  },
  info: {
    bg: 'rgba(156, 163, 175, 0.10)',
    border: bondfireColors.ash,
    text: bondfireColors.whiteSmoke,
  },
  success: {
    bg: 'rgba(34, 197, 94, 0.15)',
    border: bondfireColors.success,
    text: bondfireColors.whiteSmoke,
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
        <View
          style={{
            backgroundColor: styles.bg,
            borderWidth: 1,
            borderColor: styles.border,
            borderRadius: 12,
            paddingVertical: 10,
            paddingHorizontal: 14,
            gap: 4,
            shadowColor: 'rgba(0,0,0,0.3)',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 6,
            elevation: 4,
          }}
        >
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{ fontSize: 14, fontWeight: '600', color: styles.text, lineHeight: 18 }}
                numberOfLines={2}
              >
                {entry.message}
              </Text>
              {entry.referenceId ? (
                <Text style={{ fontSize: 11, color: bondfireColors.ash, lineHeight: 14 }}>
                  Ref: {entry.referenceId}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={handleDismiss} style={{ marginLeft: 8, padding: 4 }}>
              <Text style={{ fontSize: 16, color: bondfireColors.ash }}>✕</Text>
            </Pressable>
          </View>
        </View>
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
