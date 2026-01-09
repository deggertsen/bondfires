import { useValue } from '@legendapp/state/react'
import { appActions, appStore$ } from '../store/app.store'

export function useAuth() {
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const userId = useValue(appStore$.userId)

  return {
    isAuthenticated,
    userId,
    setAuth: appActions.setAuth,
    logout: appActions.logout,
  }
}

export function useOnboarding() {
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)

  return {
    hasSeenOnboarding,
    completeOnboarding: appActions.completeOnboarding,
  }
}

export function usePreferences() {
  const preferences = useValue(appStore$.preferences)

  return {
    preferences,
    setVideoQuality: appActions.setVideoQuality,
    setAutoplayVideos: appActions.setAutoplayVideos,
    setNotificationsEnabled: appActions.setNotificationsEnabled,
  }
}
