import { useQuery } from 'convex/react'
import Constants from 'expo-constants'
import * as ExpoInAppUpdates from 'expo-in-app-updates'
import * as Linking from 'expo-linking'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
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
}

// ---------------------------------------------------------------------------
// Store URLs (fallback)
// ---------------------------------------------------------------------------

const APP_STORE_URL = 'https://apps.apple.com/us/app/bondfires/id6755933598'
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=org.bondfires'

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

function getStoreUrl(): string {
  if (Platform.OS === 'android') return PLAY_STORE_URL
  return APP_STORE_URL
}

async function openPlatformStore(): Promise<void> {
  await Linking.openURL(getStoreUrl())
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
  const autoStartAttemptedRef = useRef(false)

  // ----------------------------------------------------------
  // Step 1: Check Convex remote config for min version
  // ----------------------------------------------------------
  useEffect(() => {
    if (updateConfig === undefined) return

    const currentVersion = Constants.expoConfig?.version ?? '0.0.0'
    const { minAppVersion } = updateConfig
    const updatePriority: UpdatePriority =
      updateConfig.updatePriority === 'flexible' ? 'flexible' : 'immediate'
    const updateRequired = !!minAppVersion && compareVersions(currentVersion, minAppVersion) < 0

    if (!updateRequired) {
      autoStartAttemptedRef.current = false
    }

    setState((s) => ({
      ...s,
      loading: false,
      updateRequired,
      downloading: updateRequired ? s.downloading : false,
      updateReady: updateRequired ? s.updateReady : false,
      minRequiredVersion: minAppVersion,
      updatePriority,
    }))
  }, [updateConfig])

  // ----------------------------------------------------------
  // Step 2: Track native in-app update events
  // ----------------------------------------------------------
  useEffect(() => {
    if (Platform.OS !== 'android') return

    const removeStartListener = ExpoInAppUpdates.addUpdateListener('updateStart', (event) => {
      setState((s) => ({
        ...s,
        downloading: event.updateType === 'FLEXIBLE',
        updateReady: false,
      }))
    })

    const removeDownloadedListener = ExpoInAppUpdates.addUpdateListener(
      'updateDownloaded',
      (event) => {
        if (event.readyToInstall) {
          setState((s) => ({ ...s, downloading: false, updateReady: true }))
        }
      },
    )

    const removeCompletedListener = ExpoInAppUpdates.addUpdateListener('updateCompleted', () => {
      setState((s) => ({
        ...s,
        updateRequired: false,
        downloading: false,
        updateReady: false,
      }))
    })

    const removeCancelledListener = ExpoInAppUpdates.addUpdateListener('updateCancelled', () => {
      setState((s) => ({ ...s, downloading: false, updateReady: false }))
    })

    return () => {
      removeStartListener()
      removeDownloadedListener()
      removeCompletedListener()
      removeCancelledListener()
    }
  }, [])

  // ----------------------------------------------------------
  // Actions
  // ----------------------------------------------------------

  const startUpdate = useCallback(async () => {
    if (Platform.OS === 'android') {
      try {
        const result = await ExpoInAppUpdates.checkForUpdate()

        if (!result.updateAvailable) {
          await openPlatformStore()
          return
        }

        if (state.updatePriority === 'flexible' && result.flexibleAllowed) {
          setState((s) => ({ ...s, downloading: true }))
          const started = await ExpoInAppUpdates.startUpdate(false)
          if (started) return
          setState((s) => ({ ...s, downloading: false }))
        }

        if (result.immediateAllowed) {
          const started = await ExpoInAppUpdates.startUpdate(true)
          if (started) return
        }

        await openPlatformStore()
      } catch (_err) {
        setState((s) => ({ ...s, downloading: false }))
        await openPlatformStore().catch(() => {
          // Store fallback failed; keep the force-update UI visible for retry.
        })
      }
      return
    }

    try {
      const started = await ExpoInAppUpdates.startUpdate()
      if (!started) {
        await openPlatformStore()
      }
    } catch (_err) {
      await openPlatformStore().catch(() => {
        // Store fallback failed; keep the force-update UI visible for retry.
      })
    }
  }, [state.updatePriority])

  // ----------------------------------------------------------
  // Step 3: Automatically start Android flexible updates once
  // ----------------------------------------------------------
  useEffect(() => {
    if (
      Platform.OS !== 'android' ||
      !state.updateRequired ||
      state.updatePriority !== 'flexible' ||
      state.downloading ||
      state.updateReady ||
      autoStartAttemptedRef.current
    ) {
      return
    }

    autoStartAttemptedRef.current = true
    const timer = setTimeout(() => {
      startUpdate().catch(() => {
        setState((s) => ({ ...s, downloading: false }))
      })
    }, 500)

    return () => clearTimeout(timer)
  }, [
    startUpdate,
    state.downloading,
    state.updatePriority,
    state.updateReady,
    state.updateRequired,
  ])

  return { ...state, startUpdate }
}

/**
 * Opens the app store listing for the current platform.
 */
export function openAppStore(): void {
  openPlatformStore().catch(() => {
    // Fallback failed; nothing more we can do from this fire-and-forget helper.
  })
}
