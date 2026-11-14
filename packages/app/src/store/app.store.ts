import { observable, syncState, when } from '@legendapp/state'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'
import { configureObservableSync, syncObservable } from '@legendapp/state/sync'
import { isPushPrimerEligible } from '../utils/pushNudge'
import { appSessionStore$ } from './appSession.store'

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
    playbackQuality: 720 | 1080
    playbackSpeed: number // 1.0 to 2.0
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
  // (the finished-recording screen, or the feed once the user has recorded).
  pushPrimer: {
    // Last time the pre-prompt was shown (ms epoch). Shown at most once per
    // app session (appSessionStore$).
    lastShownAt: number | null
    // Times the user said no ("Not now", or back from Settings still off).
    // Stop asking after PUSH_PRIMER_MAX_DECLINES.
    declineCount: number
    // User said yes and the OS permission was actually granted.
    accepted: boolean
  }
}

const defaultState: AppState = {
  hasSeenOnboarding: false,
  preferences: {
    autoplayVideos: true,
    videoMuted: true,
    notificationsEnabled: true,
    playbackQuality: 720,
    playbackSpeed: 1.0,
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
const CURRENT_MIGRATION_VERSION = 4

when(syncState(appStore$).isPersistLoaded, () => {
  const persistedVersion = appStore$.migrationVersion.peek() ?? 0
  if (persistedVersion >= CURRENT_MIGRATION_VERSION) {
    return
  }

  // v2 — captions were introduced as an on-by-default preference. Persisted
  // preference objects from existing installs predate the key, so seed it
  // explicitly after hydration instead of relying on the in-code default.
  if (persistedVersion < 2) {
    appStore$.preferences.captionsEnabled.set(true)
  }

  if (persistedVersion < 3) {
    appStore$.preferences.playbackQuality.set(720)
  }

  // v4 — before the push nudge shipped, tapping "Notify me" marked the primer
  // accepted even when the OS dialog was then denied, which silenced those
  // users for good. Clear it once: the primer checks the OS permission before
  // opening, so users who did grant it still never see the sheet.
  if (persistedVersion < 4) {
    appStore$.pushPrimer.accepted.set(false)
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

  setPlaybackQuality: (quality: 720 | 1080) => {
    appStore$.preferences.playbackQuality.set(quality)
  },

  setPlaybackSpeed: (speed: number) => {
    appStore$.preferences.playbackSpeed.set(speed)
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
  shouldShowPushPrimer: (): boolean =>
    isPushPrimerEligible(appStore$.pushPrimer.get(), appSessionStore$.startedAt.peek()),

  recordPushPrimerShown: () => {
    appStore$.pushPrimer.lastShownAt.set(Date.now())
  },

  /**
   * Claim the primer synchronously: returns null when it is not eligible,
   * otherwise records "shown" (so a second mount in the same moment sees it
   * was already shown this session) and returns a release function. Call release only if the sheet
   * never actually opened, to hand the slot back.
   */
  claimPushPrimer: (): (() => void) | null => {
    if (!appActions.shouldShowPushPrimer()) return null
    const previous = appStore$.pushPrimer.lastShownAt.peek()
    const claimedAt = Date.now()
    appStore$.pushPrimer.lastShownAt.set(claimedAt)
    return () => {
      if (appStore$.pushPrimer.lastShownAt.peek() === claimedAt) {
        appStore$.pushPrimer.lastShownAt.set(previous)
      }
    }
  },

  recordPushPrimerDeclined: () => {
    appStore$.pushPrimer.declineCount.set((count) => count + 1)
  },

  recordPushPrimerAccepted: () => {
    appStore$.pushPrimer.accepted.set(true)
  },
}
