import { useQuery } from 'convex/react'
import { requireOptionalNativeModule } from 'expo'
import Constants from 'expo-constants'
import type {
  UpdateCancelledEvent,
  UpdateCompletedEvent,
  UpdateDownloadedEvent,
  UpdateStartEvent,
} from 'expo-in-app-updates'
import * as Linking from 'expo-linking'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { api } from '../../../../convex/_generated/api'
import { telemetry } from '../services/telemetry'

// ---------------------------------------------------------------------------
// Guarded native module access
// ---------------------------------------------------------------------------
//
// `expo-in-app-updates` eagerly calls `requireNativeModule()` at import time,
// which throws (and white-screens the entire app) when the native pod is not
// present in the binary — e.g. on iOS where the module's podspec minimum
// deployment target is higher than the app's. In-app updates are an optional,
// non-critical feature, so we load the module defensively and degrade to the
// App Store / Play Store redirect path when it is unavailable.

type CheckForUpdateResult = {
  updateAvailable: boolean
  storeVersion?: string
  flexibleAllowed?: boolean
  immediateAllowed?: boolean
}

type InAppUpdateEventMap = {
  updateStart: UpdateStartEvent
  updateDownloaded: UpdateDownloadedEvent
  updateCompleted: UpdateCompletedEvent
  updateCancelled: UpdateCancelledEvent
}

type NativeInAppUpdatesModule = {
  FLEXIBLE: number
  IMMEDIATE: number
  checkForUpdate: () => Promise<CheckForUpdateResult>
  startUpdate: (updateType?: number) => Promise<boolean>
  addListener: <K extends keyof InAppUpdateEventMap>(
    eventName: K,
    listener: (event: InAppUpdateEventMap[K]) => void,
  ) => { remove: () => void }
}

const nativeInAppUpdates = requireOptionalNativeModule<NativeInAppUpdatesModule>('ExpoInAppUpdates')

let nativeMissingLogged = false
function warnNativeModuleMissing(): void {
  if (nativeMissingLogged) return
  nativeMissingLogged = true
  telemetry.warn(
    'inAppUpdates:nativeModuleMissing',
    'ExpoInAppUpdates native module unavailable; in-app updates disabled',
    { platform: Platform.OS },
  )
}

const ExpoInAppUpdates = {
  async checkForUpdate(): Promise<CheckForUpdateResult> {
    if (!nativeInAppUpdates) {
      warnNativeModuleMissing()
      return { updateAvailable: false }
    }
    return nativeInAppUpdates.checkForUpdate()
  },
  async startUpdate(isImmediate?: boolean): Promise<boolean> {
    if (!nativeInAppUpdates) {
      warnNativeModuleMissing()
      return false
    }
    if (Platform.OS === 'android') {
      const updateType =
        isImmediate === undefined
          ? undefined
          : isImmediate
            ? nativeInAppUpdates.IMMEDIATE
            : nativeInAppUpdates.FLEXIBLE
      return nativeInAppUpdates.startUpdate(updateType)
    }
    return nativeInAppUpdates.startUpdate()
  },
  addUpdateListener<K extends keyof InAppUpdateEventMap>(
    eventName: K,
    listener: (event: InAppUpdateEventMap[K]) => void,
  ): () => void {
    if (!nativeInAppUpdates) {
      warnNativeModuleMissing()
      return () => {}
    }
    return nativeInAppUpdates.addListener(eventName, listener).remove
  },
}

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

function getUpdatePriority(value: string | null | undefined): UpdatePriority {
  return value === 'flexible' ? 'flexible' : 'immediate'
}

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

function storeVersionCanSatisfyRequiredVersion(
  storeVersion: string | undefined,
  minRequiredVersion: string,
): boolean {
  if (Platform.OS !== 'ios') return true
  if (!storeVersion) return false
  return compareVersions(storeVersion, minRequiredVersion) >= 0
}

function canDownloadAndroidUpdate(
  result: Awaited<ReturnType<typeof ExpoInAppUpdates.checkForUpdate>>,
) {
  return !!(result.updateAvailable && (result.flexibleAllowed || result.immediateAllowed))
}

async function canDownloadRequiredUpdate(minRequiredVersion: string): Promise<boolean> {
  try {
    const result = await ExpoInAppUpdates.checkForUpdate()

    if (!result.updateAvailable) return false
    if (!storeVersionCanSatisfyRequiredVersion(result.storeVersion, minRequiredVersion))
      return false

    if (Platform.OS === 'android') {
      return canDownloadAndroidUpdate(result)
    }

    return true
  } catch (_err) {
    return false
  }
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
  // Step 1: Check Convex remote config and verify a downloadable update exists
  // ----------------------------------------------------------
  useEffect(() => {
    if (updateConfig === undefined) return

    // Dev builds should not be blocked by production minimum-version gating.
    if (__DEV__) {
      setState({
        loading: false,
        updateRequired: false,
        downloading: false,
        updateReady: false,
        minRequiredVersion: updateConfig.minAppVersion ?? null,
        updatePriority: getUpdatePriority(updateConfig.updatePriority),
      })
      return
    }

    let cancelled = false
    const currentVersion = Constants.expoConfig?.version ?? '0.0.0'
    const { minAppVersion } = updateConfig
    const updatePriority = getUpdatePriority(updateConfig.updatePriority)
    const belowRequiredVersion =
      !!minAppVersion && compareVersions(currentVersion, minAppVersion) < 0

    if (!belowRequiredVersion || !minAppVersion) {
      autoStartAttemptedRef.current = false
      setState((s) => ({
        ...s,
        loading: false,
        updateRequired: false,
        downloading: false,
        updateReady: false,
        minRequiredVersion: minAppVersion,
        updatePriority,
      }))
      return
    }

    setState((s) => ({
      ...s,
      loading: true,
      updateRequired: false,
      downloading: false,
      updateReady: false,
      minRequiredVersion: minAppVersion,
      updatePriority,
    }))

    canDownloadRequiredUpdate(minAppVersion).then((canDownload) => {
      if (cancelled) return

      if (!canDownload) {
        autoStartAttemptedRef.current = false
      }

      setState((s) => ({
        ...s,
        loading: false,
        updateRequired: canDownload,
        downloading: canDownload ? s.downloading : false,
        updateReady: canDownload ? s.updateReady : false,
        minRequiredVersion: minAppVersion,
        updatePriority,
      }))
    })

    return () => {
      cancelled = true
    }
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

        if (!result.updateAvailable || !canDownloadAndroidUpdate(result)) {
          setState((s) => ({
            ...s,
            updateRequired: false,
            downloading: false,
            updateReady: false,
          }))
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

        if (result.flexibleAllowed) {
          setState((s) => ({ ...s, downloading: true }))
          const started = await ExpoInAppUpdates.startUpdate(false)
          if (started) return
          setState((s) => ({ ...s, downloading: false }))
        }

        setState((s) => ({
          ...s,
          updateRequired: false,
          downloading: false,
          updateReady: false,
        }))
      } catch (_err) {
        setState((s) => ({
          ...s,
          updateRequired: false,
          downloading: false,
          updateReady: false,
        }))
      }
      return
    }

    try {
      const result = await ExpoInAppUpdates.checkForUpdate()
      if (
        !result.updateAvailable ||
        !state.minRequiredVersion ||
        !storeVersionCanSatisfyRequiredVersion(result.storeVersion, state.minRequiredVersion)
      ) {
        setState((s) => ({
          ...s,
          updateRequired: false,
          downloading: false,
          updateReady: false,
        }))
        return
      }

      const started = await ExpoInAppUpdates.startUpdate()
      if (!started) {
        await openPlatformStore()
      }
    } catch (_err) {
      setState((s) => ({
        ...s,
        updateRequired: false,
        downloading: false,
        updateReady: false,
      }))
    }
  }, [state.minRequiredVersion, state.updatePriority])

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
