/**
 * Convex React Native Polyfill
 *
 * Convex checks `typeof window === "undefined"` to detect non-browser
 * environments, but React Native has a `window` object without browser methods
 * like `addEventListener`. Convex's WebSocket manager registers `online` /
 * `offline` / `visibilitychange` listeners on `window` and, on `online`, resets
 * its reconnect backoff and reconnects immediately.
 *
 * The previous polyfill no-op'd `addEventListener`, so those listeners were
 * silently dropped: after the socket dropped (backgrounding, a network blip,
 * the flaky Android-emulator socket), Convex never got an `online` signal and
 * fell back to slow internal backoff — the app would sit on a spinner with all
 * queries stuck in `undefined`.
 *
 * This polyfill instead keeps a real listener registry and drives an `online`
 * event whenever the app returns to the foreground (via `AppState`), so Convex
 * reconnects promptly. This is dependency-free; a fuller connectivity-driven
 * reconnect that also catches mid-session network flaps would layer NetInfo /
 * expo-network on top of the same registry.
 *
 * This should be imported BEFORE any Convex imports.
 *
 * See: https://github.com/get-convex/convex-backend/issues/74
 */

import { AppState, Platform } from 'react-native'

if (Platform.OS !== 'web') {
  const win = (typeof window !== 'undefined' ? window : globalThis) as Window & typeof globalThis

  // Only install the registry if the browser methods are missing (they are on
  // RN). We keep listeners per event type and dispatch real Event-like objects.
  if (!win.addEventListener) {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

    const invoke = (listener: EventListenerOrEventListenerObject, event: Event) => {
      try {
        if (typeof listener === 'function') {
          listener(event)
        } else {
          listener.handleEvent(event)
        }
      } catch {
        // A misbehaving listener must not break connectivity dispatch.
      }
    }

    win.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (!listener) return
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    }) as typeof window.addEventListener

    win.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener)
    }) as typeof window.removeEventListener

    const dispatch = (type: string) => {
      const set = listeners.get(type)
      if (!set || set.size === 0) return
      const event =
        typeof Event === 'function'
          ? new Event(type)
          : ({ type, target: win, currentTarget: win } as unknown as Event)
      for (const listener of set) {
        invoke(listener, event)
      }
    }

    // RN has no browser `online` event. Use foregrounding as the reconnect
    // trigger: when the app becomes active, tell Convex the connection is
    // available again so it resets backoff and reconnects immediately rather
    // than waiting out a long backoff with the socket silently dead.
    AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        dispatch('online')
      }
    })
  }

  if (!win.removeEventListener) {
    win.removeEventListener = (() => {}) as typeof window.removeEventListener
  }
}
