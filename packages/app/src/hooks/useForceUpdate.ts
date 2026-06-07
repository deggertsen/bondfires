import { useQuery } from 'convex/react'
import Constants from 'expo-constants'
import * as Linking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { api } from '../../../../convex/_generated/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ForceUpdateState {
  /** True while checking the remote config. */
  loading: boolean
  /** True if the current app version is below the minimum required. */
  updateRequired: boolean
  /** The minimum required version from remote config. */
  minRequiredVersion: string | null
  /** Deep link to the app store listing. */
  storeUrl: string | null
}

// ---------------------------------------------------------------------------
// Store URLs
// ---------------------------------------------------------------------------

const APP_STORE_URL = 'https://apps.apple.com/us/app/bondfires/id6755933598'
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=org.bondfires'

function getStoreUrl(): string {
  if (Platform.OS === 'ios') return APP_STORE_URL
  if (Platform.OS === 'android') return PLAY_STORE_URL
  return APP_STORE_URL
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings (e.g. "1.0.23" vs "1.0.24").
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
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

export function useForceUpdate(): ForceUpdateState {
  const [state, setState] = useState<ForceUpdateState>({
    loading: true,
    updateRequired: false,
    minRequiredVersion: null,
    storeUrl: null,
  })

  const minVersion = useQuery(api.publicConfig.getMinVersion)

  useEffect(() => {
    // Still loading from Convex
    if (minVersion === undefined) return

    const currentVersion = Constants.expoConfig?.version ?? '0.0.0'
    const required = minVersion ?? null

    if (required && compareVersions(currentVersion, required) < 0) {
      setState({
        loading: false,
        updateRequired: true,
        minRequiredVersion: required,
        storeUrl: getStoreUrl(),
      })
    } else {
      setState({
        loading: false,
        updateRequired: false,
        minRequiredVersion: required,
        storeUrl: getStoreUrl(),
      })
    }
  }, [minVersion])

  return state
}

/**
 * Opens the app store listing for the current platform.
 */
export function openAppStore(): void {
  const url =
    Platform.OS === 'ios'
      ? APP_STORE_URL
      : Platform.OS === 'android'
        ? PLAY_STORE_URL
        : APP_STORE_URL

  Linking.openURL(url).catch(() => {
    // Fallback: couldn't open store link — nothing more we can do
  })
}
