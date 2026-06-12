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

  // Push permission priming — we never fire the one-shot OS permission
  // dialog cold. An in-app pre-prompt asks first, at a high-intent moment
  // (the finished-recording screen after the user's first commit).
  pushPrimer: {
    // Last time the pre-prompt was shown (ms epoch). Never re-show within 7 days.
    lastShownAt: number | null
    // Times the user dismissed the pre-prompt. Stop asking after 3.
    declineCount: number
    // User said yes and we fired (or attempted) the OS dialog.
    accepted: boolean
  }
}

const defaultState: AppState = {
  hasSeenOnboarding: false,
  preferences: {
    videoQuality: 'auto',
    autoplayVideos: true,
    videoMuted: true,
    notificationsEnabled: true,
    playbackSpeed: 1.0,
    livePublishEnabled: true,
  },
  isAuthenticated: false,
  userId: null,
  currentCampId: null,
  pushPrimer: {
    lastShownAt: null,
    declineCount: 0,
    accepted: false,
  },
}

const PUSH_PRIMER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const PUSH_PRIMER_MAX_DECLINES = 3

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

  // ── Push permission priming ──

  /** Whether the in-app push pre-prompt may be shown right now. */
  shouldShowPushPrimer: (): boolean => {
    const primer = appStore$.pushPrimer.get()
    if (primer.accepted) return false
    if (primer.declineCount >= PUSH_PRIMER_MAX_DECLINES) return false
    if (primer.lastShownAt !== null && Date.now() - primer.lastShownAt < PUSH_PRIMER_COOLDOWN_MS) {
      return false
    }
    return true
  },

  recordPushPrimerShown: () => {
    appStore$.pushPrimer.lastShownAt.set(Date.now())
  },

  recordPushPrimerDeclined: () => {
    appStore$.pushPrimer.declineCount.set((count) => count + 1)
  },

  recordPushPrimerAccepted: () => {
    appStore$.pushPrimer.accepted.set(true)
  },
}
