import { observable } from '@legendapp/state'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'
import { configureObservableSync, syncObservable } from '@legendapp/state/sync'

// Configure MMKV as default persistence plugin
configureObservableSync({
  persist: {
    plugin: ObservablePersistMMKV,
  },
})

// App-wide state that persists
export interface AppState {
  // Onboarding
  hasSeenOnboarding: boolean

  // User preferences
  preferences: {
    videoQuality: 'auto' | 'hd' | 'sd'
    autoplayVideos: boolean
    notificationsEnabled: boolean
    playbackSpeed: number // 1.0 to 2.0
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
    playbackSpeed: 1.0,
  },
  isAuthenticated: false,
  userId: null,
}

// Create the observable store
export const appStore$ = observable<AppState>(defaultState)

// Sync/persist the store with MMKV
syncObservable(appStore$, {
  persist: {
    name: 'bondfires-app',
  },
})

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

  setPlaybackSpeed: (speed: number) => {
    appStore$.preferences.playbackSpeed.set(speed)
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
