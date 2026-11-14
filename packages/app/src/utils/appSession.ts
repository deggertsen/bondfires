/**
 * Pure helpers for app-session tracking (`appSessionStore$`). Kept free of
 * native imports so they can be unit tested in node.
 */

/** Time in the background after which coming back counts as a new session. */
export const APP_SESSION_IDLE_MS = 30 * 60 * 1000

/** Whether returning to the foreground starts a new app session. */
export function startsNewAppSession(backgroundedAt: number | null, now: number): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= APP_SESSION_IDLE_MS
}
