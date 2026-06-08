import { useMutation, useQuery } from 'convex/react'
import { useMemo } from 'react'
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
 * - null     → "dark" (fallback, matches current production)
 */
export function useAppTheme() {
  const systemColorScheme = useColorScheme()
  const currentUser = useQuery(api.users.current)
  const setThemePreference = useMutation(api.users.setThemePreference)

  const themePreference: ThemePreference = currentUser?.themePreference ?? 'system'

  const resolvedTheme = useMemo<'light' | 'dark'>(() => {
    if (themePreference === 'system') {
      return systemColorScheme === 'light' ? 'light' : 'dark'
    }
    return themePreference
  }, [themePreference, systemColorScheme])

  return {
    /** The resolved theme: "light" or "dark" — pass to `<Theme name={...}>` */
    themeName: resolvedTheme,
    /** Raw user preference (may be "system") */
    themePreference,
    /** Set the theme preference (persists to Convex) */
    setThemePreference: (pref: ThemePreference) => setThemePreference({ themePreference: pref }),
    /** True while the Convex query is loading */
    isLoading: currentUser === undefined,
  }
}
