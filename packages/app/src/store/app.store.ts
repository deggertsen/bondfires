import { observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'

// App-wide state that persists
export interface AppState {
  // Onboarding
  hasSeenOnboarding: boolean
  
  // User preferences
  preferences: {
    videoQuality: 'auto' | 'hd' | 'sd'
    autoplayVideos: boolean
    notificationsEnabled: boolean
  }
  
  // Auth state (managed by Convex, but cached locally)
  isAuthenticated: boolean
  userId: string | null
}

const defaultState: AppState = {
  hasSeenOnboarding: false,
  preferences: {
    videoQuality: 'auto',
    autoplayVideos: true,
    notificationsEnabled: true,
  },
  isAuthenticated: false,
  userId: null,
}

// Create the observable store with MMKV persistence
export const appStore$ = observable<AppState>(
  synced({
    initial: defaultState,
    persist: {
      name: 'bondfires-app',
      plugin: ObservablePersistMMKV,
    },
  })
)

// Actions
export const appActions = {
  completeOnboarding: () => {
    appStore$.hasSeenOnboarding.set(true)
  },
  
  setVideoQuality: (quality: AppState['preferences']['videoQuality']) => {
    appStore$.preferences.videoQuality.set(quality)
  },
  
  setAutoplayVideos: (enabled: boolean) => {
    appStore$.preferences.autoplayVideos.set(enabled)
  },
  
  setNotificationsEnabled: (enabled: boolean) => {
    appStore$.preferences.notificationsEnabled.set(enabled)
  },
  
  setAuth: (userId: string | null) => {
    appStore$.isAuthenticated.set(!!userId)
    appStore$.userId.set(userId)
  },
  
  logout: () => {
    appStore$.isAuthenticated.set(false)
    appStore$.userId.set(null)
  },
  
  reset: () => {
    appStore$.set(defaultState)
  },
}
