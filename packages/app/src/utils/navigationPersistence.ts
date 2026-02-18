import { mmkvStorage } from './storage'

const KEY_LAST_LOCATION = 'nav:lastLocation:v1'
const KEY_FEED_ACTIVE_BONDFIRE_ID = 'nav:feed:activeBondfireId:v1'
const KEY_BONDFIRE_VIDEO_INDEX_PREFIX = 'nav:bondfire:videoIndex:v1:'

export type LastLocation =
  | { type: 'feed'; activeBondfireId?: string; updatedAt: number }
  | { type: 'bondfire'; bondfireId: string; videoIndex: number; updatedAt: number }

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function getLastLocation(): LastLocation | null {
  return safeJsonParse<LastLocation>(mmkvStorage.getItem(KEY_LAST_LOCATION))
}

export function setLastLocation(location: LastLocation) {
  mmkvStorage.setItem(KEY_LAST_LOCATION, JSON.stringify(location))
}

export function setFeedActiveBondfireId(bondfireId: string | null) {
  if (bondfireId) {
    mmkvStorage.setItem(KEY_FEED_ACTIVE_BONDFIRE_ID, bondfireId)
    setLastLocation({ type: 'feed', activeBondfireId: bondfireId, updatedAt: Date.now() })
  } else {
    mmkvStorage.removeItem(KEY_FEED_ACTIVE_BONDFIRE_ID)
    setLastLocation({ type: 'feed', updatedAt: Date.now() })
  }
}

export function getFeedActiveBondfireId(): string | null {
  return mmkvStorage.getItem(KEY_FEED_ACTIVE_BONDFIRE_ID)
}

export function setBondfireVideoIndex(bondfireId: string, videoIndex: number) {
  if (!bondfireId) return
  const normalized = Math.max(0, Math.floor(videoIndex))
  mmkvStorage.setItem(`${KEY_BONDFIRE_VIDEO_INDEX_PREFIX}${bondfireId}`, String(normalized))
  setLastLocation({ type: 'bondfire', bondfireId, videoIndex: normalized, updatedAt: Date.now() })
}

export function getBondfireVideoIndex(bondfireId: string): number | null {
  if (!bondfireId) return null
  const raw = mmkvStorage.getItem(`${KEY_BONDFIRE_VIDEO_INDEX_PREFIX}${bondfireId}`)
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

