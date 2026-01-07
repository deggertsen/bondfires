import { useObservable } from '@legendapp/state/react'
import { appStore$, appActions } from '../store/app.store'

export function useAuth() {
  const isAuthenticated = useObservable(appStore$.isAuthenticated)
  const userId = useObservable(appStore$.userId)
  
  return {
    isAuthenticated: isAuthenticated.get(),
    userId: userId.get(),
    setAuth: appActions.setAuth,
    logout: appActions.logout,
  }
}

export function useOnboarding() {
  const hasSeenOnboarding = useObservable(appStore$.hasSeenOnboarding)
  
  return {
    hasSeenOnboarding: hasSeenOnboarding.get(),
    completeOnboarding: appActions.completeOnboarding,
  }
}

export function usePreferences() {
  const preferences = useObservable(appStore$.preferences)
  
  return {
    preferences: preferences.get(),
    setVideoQuality: appActions.setVideoQuality,
    setAutoplayVideos: appActions.setAutoplayVideos,
    setNotificationsEnabled: appActions.setNotificationsEnabled,
  }
}

