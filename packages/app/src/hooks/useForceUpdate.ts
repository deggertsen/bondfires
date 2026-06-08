import Constants from 'expo-constants'
import { useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import ExpoInAppUpdates from 'expo-in-app-updates'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdatePriority = 'flexible' | 'immediate'

export interface ForceUpdateState {
  /** True while checking the remote config. */
  loading: boolean
  /** True if the current app version is below the minimum required. */
  updateRequired: boolean
  /** True while a flexible (background) update is downloading on Android. */
  downloading: boolean
  /** True when a flexible update has been downloaded and is ready to install. */
  updateReady: boolean
  /** The minimum required version from remote config. */
  minRequiredVersion: string | null
  /** The update priority from remote config. */
  updatePriority: UpdatePriority | null
}

export interface InAppUpdateActions {
  /** Start a flexible update download (Android) or open the store (iOS). */
  startUpdate: () => Promise<void>
  /** Install the downloaded flexible update and restart the app (Android only). */
  installUpdate: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Store URLs (iOS fallback)
// ---------------------------------------------------------------------------

const APP_STORE_URL = 'https://apps.apple.com/us/app/bondfires/id6755933598'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] ?? 0
    const bVal = bParts[i] ?? 0
    if (aVal < bVal) return -1
    if (aVal > bVal) return 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useForceUpdate(): ForceUpdateState & InAppUpdateActions {
  const [state, setState] = useState<ForceUpdateState>({
    loading: true,
    updateRequired: false,
    downloading: false,
    updateReady: false,
    minRequiredVersion: null,
    updatePriority: null,
  })

  const updateConfig = useQuery(api.publicConfig.getUpdateConfig)
  const startedRef = useRef(false)
  const checkRanRef = useRef(false)

  // ----------------------------------------------------------
  // Step 1: Check Convex remote config for min version
  // ----------------------------------------------------------
  useEffect(() => {
    if (updateConfig === undefined || checkRanRef.current) return
    checkRanRef.current = true

    const currentVersion = Constants.expoConfig?.version ?? '0.0.0'
    const { minAppVersion, updatePriority } = updateConfig

    if (minAppVersion && compareVersions(currentVersion, minAppVersion) < 0) {
      setState((s) => ({
        ...s,
        loading: false,
        updateRequired: true,
        minRequiredVersion: minAppVersion,
        updatePriority,
      }))
    } else {
      setState((s) => ({
        ...s,
        loading: false,
        updateRequired: false,
        minRequiredVersion: minAppVersion,
        updatePriority,
      }))
    }
  }, [updateConfig])

  // ----------------------------------------------------------
  // Step 2: On Android, try native check first for flexible mode
  // ----------------------------------------------------------
  useEffect(() => {
    if (!state.updateRequired || state.updatePriority !== 'flexible' || startedRef.current) return

    // Only Android supports flexible in-app updates
    if (Platform.OS !== 'android') return

    // Give the native module a moment, then attempt flexible update
    const timer = setTimeout(async () => {
      try {
        const result = await ExpoInAppUpdates.checkForUpdate()
        if (result.updateAvailable && result.flexibleAllowed) {
          startedRef.current = true
          setState((s) => ({ ...s, downloading: true }))
          await ExpoInAppUpdates.startUpdate()
          // On successful start, the Play Core UI handles progress.
          // We check again to see if it was completed synchronously.
          const checkAgain = await ExpoInAppUpdates.checkForUpdate()
          if (!checkAgain.updateAvailable) {
            // Update was applied — this shouldn't normally happen
            // without a restart, but handle it gracefully
            setState((s) => ({ ...s, downloading: false, updateReady: true }))
          }
        }
      } catch (_err) {
        // Flexible update failed — revert to immediate/fallback UI
        setState((s) => ({ ...s, downloading: false }))
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [state.updateRequired, state.updatePriority])

  // ----------------------------------------------------------
  // Actions
  // ----------------------------------------------------------

  const startUpdate = async () => {
    if (Platform.OS === 'android') {
      try {
        const result = await ExpoInAppUpdates.checkForUpdate()
        if (result.updateAvailable && result.flexibleAllowed) {
          setState((s) => ({ ...s, downloading: true }))
          await ExpoInAppUpdates.startUpdate()
          // After startUpdate returns, the download is in progress.
          // The Play Core library downloads in the background.
          // We poll checkForUpdate to detect completion.
          pollForCompletion()
        } else if (result.updateAvailable && result.immediateAllowed) {
          // Fallback to immediate update within the app
          await ExpoInAppUpdates.startUpdate()
        } else {
          // Fallback to Play Store
          const { Linking } = require('react-native')
          Linking.openURL('https://play.google.com/store/apps/details?id=org.bondfires')
        }
      } catch (_err) {
        // Fallback to store
        const { Linking } = require('react-native')
        Linking.openURL('https://play.google.com/store/apps/details?id=org.bondfires')
      }
    } else {
      // iOS: open App Store via expo-in-app-updates
      try {
        await ExpoInAppUpdates.checkAndStartUpdate()
      } catch (_err) {
        const { Linking } = require('react-native')
        Linking.openURL(APP_STORE_URL)
      }
    }
  }

  const pollForCompletion = async () => {
    // Poll for flexible update download completion
    const maxPolls = 60 // ~2 minutes at 2s intervals
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const result = await ExpoInAppUpdates.checkForUpdate()
        // When flexible update downloads, updateAvailable becomes false
        // and the app needs a restart to apply
        if (result.updateAvailable === false && state.downloading) {
          setState((s) => ({ ...s, downloading: false, updateReady: true }))
          return
        }
      } catch (_e) {
        // Continue polling
      }
    }
    // Timeout — assume it completed
    setState((s) => ({ ...s, downloading: false, updateReady: true }))
  }

  const installUpdate = async () => {
    if (Platform.OS !== 'android') return
    // Restart the app to apply the downloaded update
    const { NativeModules } = require('react-native')
    const { RNAppRestart } = NativeModules
    // The Play Core library applies the update on restart.
    // expo-updates or a simple process restart handles this.
    if (RNAppRestart) {
      RNAppRestart.restartApp()
    } else {
      // Fallback: kill the process — Android will restart the activity
      const { BackHandler } = require('react-native')
      BackHandler.exitApp()
    }
  }

  return { ...state, startUpdate, installUpdate }
}
