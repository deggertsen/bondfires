export const PRESENCE_STALE_MS = 65_000

export function presenceCutoff(now: number): number {
  return now - PRESENCE_STALE_MS
}
