import { observable } from '@legendapp/state'
import { AppState } from 'react-native'
import { startsNewAppSession } from '../utils/appSession'

/**
 * Transient (not persisted) app-session state. A session starts at launch, or
 * when the app returns after `APP_SESSION_IDLE_MS` in the background. Used for
 * "once per session" prompts such as the push primer.
 */
export interface AppSessionState {
  /** When the current session started (ms epoch). */
  startedAt: number
}

export const appSessionStore$ = observable<AppSessionState>({ startedAt: Date.now() })

let backgroundedAt: number | null = null

AppState.addEventListener('change', (state) => {
  if (state === 'background') {
    backgroundedAt = Date.now()
    return
  }
  if (state === 'active') {
    const now = Date.now()
    if (startsNewAppSession(backgroundedAt, now)) appSessionStore$.startedAt.set(now)
    backgroundedAt = null
  }
})
