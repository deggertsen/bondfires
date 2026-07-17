import { useValue } from '@legendapp/state/react'
import { appActions, appStore$ } from '../store/app.store'

export function useAuth() {
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const isAuthReady = useValue(appStore$.isAuthReady)
  const userId = useValue(appStore$.userId)

  return {
    isAuthenticated,
    isAuthReady,
    userId,
    setAuth: appActions.setAuth,
    setAuthReady: appActions.setAuthReady,
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
    setAutoplayVideos: appActions.setAutoplayVideos,
    setNotificationsEnabled: appActions.setNotificationsEnabled,
    setLivePublishEnabled: appActions.setLivePublishEnabled,
  }
}
