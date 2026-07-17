import { observable, syncState, when } from '@legendapp/state'
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
    autoplayVideos: boolean
    videoMuted: boolean
    notificationsEnabled: boolean
    playbackSpeed: number // 1.0 to 2.0
    livePublishEnabled: boolean
    captionsEnabled: boolean
  }

  // Auth state (managed by Convex, but cached locally)
  isAuthenticated: boolean
  userId: string | null

  // Camp context
  currentCampId: string | null

  // Install/deep-link attribution for invite codes captured before auth.
  pendingInviteCode: string | null
  hasCompletedInviteCheck: boolean

  // Bumped when we need a one-time fix to already-persisted state. See the
  // migration block below. Absent on installs that predate this field, which
  // read as 0 and get migrated.
  migrationVersion: number

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
    autoplayVideos: true,
    videoMuted: true,
    notificationsEnabled: true,
    playbackSpeed: 1.0,
    livePublishEnabled: true,
    // On by default: videos default to muted (videoMuted above), and captions
    // make muted watching actually work.
    captionsEnabled: true,
  },
  isAuthenticated: false,
  userId: null,
  currentCampId: null,
  pendingInviteCode: null,
  hasCompletedInviteCheck: false,
  migrationVersion: 0,
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

// ── One-time migrations for already-persisted state ──────────────────────────
//
// Persisted preferences shadow code defaults: once a value lives in MMKV, later
// changes to `defaultState` never reach existing installs. Bump
// CURRENT_MIGRATION_VERSION and add a step here when a default change must also
// apply to devices that already wrote the old value.
//
// Must run AFTER persistence has loaded, or the loaded MMKV blob would clobber
// whatever the migration set. `syncState(...).isPersistLoaded` resolves
// synchronously for the MMKV plugin, so this normally fires on the same tick.
const CURRENT_MIGRATION_VERSION = 2

when(syncState(appStore$).isPersistLoaded, () => {
  const persistedVersion = appStore$.migrationVersion.peek() ?? 0
  if (persistedVersion >= CURRENT_MIGRATION_VERSION) {
    return
  }

  // v1 — live publishing became the default recording path. It originally
  // shipped as an opt-in dev toggle defaulting to `false`, so early installs
  // (David's included) persisted `livePublishEnabled: false`. That stale value
  // silently forced everyone back onto the legacy upload flow: queued Mux
  // direct uploads stuck at 0%, bondfires missing from the feed until the
  // asset finished processing, and the plain completion screen with no title
  // or invite. Clear it once; the dev toggle still sticks afterward because the
  // migration never runs again.
  if (persistedVersion < 1) {
    appStore$.preferences.livePublishEnabled.set(true)
  }

  // v2 — captions were introduced as an on-by-default preference. Persisted
  // preference objects from existing installs predate the key, so seed it
  // explicitly after hydration instead of relying on the in-code default.
  if (persistedVersion < 2) {
    appStore$.preferences.captionsEnabled.set(true)
  }

  appStore$.migrationVersion.set(CURRENT_MIGRATION_VERSION)
})

// Actions
export const appActions = {
  completeOnboarding: () => {
    appStore$.hasSeenOnboarding.set(true)
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

  setCaptionsEnabled: (enabled: boolean) => {
    appStore$.preferences.captionsEnabled.set(enabled)
  },

  setAuth: (userId: string | null) => {
    appStore$.isAuthenticated.set(!!userId)
    appStore$.userId.set(userId)
  },

  setCurrentCampId: (campId: string | null) => {
    appStore$.currentCampId.set(campId)
  },

  setPendingInviteCode: (code: string | null) => {
    appStore$.pendingInviteCode.set(code)
  },

  completeInviteCheck: () => {
    appStore$.hasCompletedInviteCheck.set(true)
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
