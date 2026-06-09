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
    videoMuted: boolean
    notificationsEnabled: boolean
    playbackSpeed: number // 1.0 to 2.0
    livePublishEnabled: boolean
  }

  // Auth state (managed by Convex, but cached locally)
  isAuthenticated: boolean
  userId: string | null

  // Camp context
  currentCampId: string | null

  // Migrations — bump this to force-apply migrations on app start
  _migrationVersion: number
}

const defaultState: AppState = {
  hasSeenOnboarding: false,
  preferences: {
    videoQuality: 'auto',
    autoplayVideos: true,
    videoMuted: true,
    notificationsEnabled: true,
    playbackSpeed: 1.0,
    livePublishEnabled: false,
  },
  isAuthenticated: false,
  userId: null,
  currentCampId: null,
  _migrationVersion: 0,
}

// Current migration version — bump when running migration logic
const CURRENT_MIGRATION_VERSION = 1

// Create the observable store
export const appStore$ = observable<AppState>(defaultState)

// Sync/persist the store with MMKV
syncObservable(appStore$, {
  persist: {
    name: 'bondfires-app',
  },
})

// ---------------------------------------------------------------------------
// Migrations — run once on app start when migration version is behind
// ---------------------------------------------------------------------------
function runMigrations(): void {
  const version = appStore$._migrationVersion.peek() ?? 0

  if (version < 1) {
    // Migration v1: force-reset livePublishEnabled to false for all users.
    // Commit 86eb177 accidentally set the default to true, enabling the
    // live publisher UI for every user — even when the native module was
    // unavailable or the camera wasn't ready.
    appStore$.preferences.livePublishEnabled.set(false)

    appStore$._migrationVersion.set(1)
  }

  // Future migrations: add version checks >= 2 here...

  // Always stamp current version so future migrations don't re-run.
  appStore$._migrationVersion.set(CURRENT_MIGRATION_VERSION)
}

// Run migrations when persistence initializes.
// syncObservable resolves the persisted snapshot before the first observer
// triggers, so we queue on the next microtask.
queueMicrotask(runMigrations)

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

  setVideoMuted: (muted: boolean) => {
    appStore$.preferences.videoMuted.set(muted)
  },

  setNotificationsEnabled: (enabled: boolean) => {
    appStore$.preferences.notificationsEnabled.set(enabled)
  },

  setPlaybackSpeed: (speed: number) => {
    appStore$.preferences.playbackSpeed.set(speed)
  },

  setLivePublishEnabled: (enabled: boolean) => {
    appStore$.preferences.livePublishEnabled.set(enabled)
  },

  setAuth: (userId: string | null) => {
    appStore$.isAuthenticated.set(!!userId)
    appStore$.userId.set(userId)
  },

  setCurrentCampId: (campId: string | null) => {
    appStore$.currentCampId.set(campId)
  },

  logout: () => {
    appStore$.isAuthenticated.set(false)
    appStore$.userId.set(null)
    appStore$.currentCampId.set(null)
  },

  reset: () => {
    appStore$.set(defaultState)
  },
}
