import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useColorScheme } from 'react-native'
import { api } from '../../../../convex/_generated/api'

export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * Reads the user's theme preference from Convex and resolves it against the
 * system color scheme to determine which Tamagui theme to render.
 *
 * Resolution:
 * - "light"  → light
 * - "dark"   → dark
 * - "system" → system color scheme (defaults to "dark" when indeterminate)
 * - null     → "system" (fallback for signed-out users and unset preferences)
 */
export function useAppTheme() {
  const systemColorScheme = useColorScheme()
  const currentUser = useQuery(api.users.current)
  const setThemePreferenceMutation = useMutation(api.users.setThemePreference)
  const [optimisticPreference, setOptimisticPreference] = useState<ThemePreference | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const serverPreference: ThemePreference = currentUser?.themePreference ?? 'system'
  const themePreference: ThemePreference = optimisticPreference ?? serverPreference

  useEffect(() => {
    if (optimisticPreference !== null && serverPreference === optimisticPreference) {
      setOptimisticPreference(null)
    }
  }, [optimisticPreference, serverPreference])

  const resolvedTheme = useMemo<'light' | 'dark'>(() => {
    if (themePreference === 'system') {
      return systemColorScheme === 'light' ? 'light' : 'dark'
    }
    return themePreference
  }, [themePreference, systemColorScheme])

  const setThemePreference = useCallback(
    async (pref: ThemePreference) => {
      setOptimisticPreference(pref)
      setIsSaving(true)
      try {
        await setThemePreferenceMutation({ themePreference: pref })
      } catch (error) {
        setOptimisticPreference(null)
        throw error
      } finally {
        setIsSaving(false)
      }
    },
    [setThemePreferenceMutation],
  )

  return {
    /** The resolved theme: "light" or "dark" — pass to `<Theme name={...}>` */
    themeName: resolvedTheme,
    /** Raw user preference (may be "system") */
    themePreference,
    /** Set the theme preference (persists to Convex) */
    setThemePreference,
    /** True while the Convex query is loading */
    isLoading: currentUser === undefined,
    /** True while a theme preference mutation is in flight */
    isSaving,
  }
}
