/**
 * Convex React Native Polyfill
 * 
 * Convex checks `typeof window === "undefined"` to detect non-browser environments,
 * but React Native has a `window` object without browser methods like `addEventListener`.
 * This polyfill provides no-op implementations for the methods Convex expects.
 * 
 * This should be imported BEFORE any Convex imports.
 * 
 * See: https://github.com/get-convex/convex-backend/issues/74
 */

import { Platform } from 'react-native'

if (Platform.OS !== 'web') {
  // Ensure window has the browser event methods Convex expects
  const win = (typeof window !== 'undefined' ? window : global) as Window & typeof globalThis

  if (!win.addEventListener) {
    // No-op: React Native handles network state via NetInfo, not browser events
    win.addEventListener = (() => {}) as typeof window.addEventListener
  }

  if (!win.removeEventListener) {
    win.removeEventListener = (() => {}) as typeof window.removeEventListener
  }
}
