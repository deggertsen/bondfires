import { type StatusBarStyle, useColorScheme } from 'react-native'
import { useAppTheme } from './useAppTheme'

export type AppThemeName = 'light' | 'dark'

export const appThemeColors = {
  dark: {
    background: '#141416',
    backgroundHover: '#1F2023',
    backgroundPress: '#33353A',
    borderColor: '#33353A',
    color: '#F3F4F6',
    placeholderColor: '#9CA3AF',
    primary: '#D97736',
    success: '#22C55E',
    error: '#EF4444',
  },
  light: {
    background: '#FAFAFA',
    backgroundHover: '#F3F4F6',
    backgroundPress: '#E5E7EB',
    borderColor: '#D1D5DB',
    color: '#141416',
    placeholderColor: '#9CA3AF',
    primary: '#D97736',
    success: '#16A34A',
    error: '#DC2626',
  },
} as const

export function getStatusBarStyle(themeName: AppThemeName): StatusBarStyle {
  return themeName === 'dark' ? 'light-content' : 'dark-content'
}

export function useSystemThemeColors() {
  const colorScheme = useColorScheme()
  const themeName: AppThemeName = colorScheme === 'light' ? 'light' : 'dark'

  return {
    themeName,
    colors: appThemeColors[themeName],
    statusBarStyle: getStatusBarStyle(themeName),
  }
}

export function useAppThemeColors() {
  const appTheme = useAppTheme()

  return {
    ...appTheme,
    colors: appThemeColors[appTheme.themeName],
    statusBarStyle: getStatusBarStyle(appTheme.themeName),
  }
}
