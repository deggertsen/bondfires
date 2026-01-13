import { observable } from '@legendapp/state'
import { syncObservable } from '@legendapp/state/sync'

// Track viewed bondfires with timestamps
interface ViewedBondfires {
  [bondfireId: string]: number // timestamp of last view
}

export const viewedBondfires$ = observable<ViewedBondfires>({})

// Sync with MMKV persistence
syncObservable(viewedBondfires$, {
  persist: {
    name: 'bondfires-viewed',
  },
})

// Check if viewed within last 24 hours
export function hasViewedToday(bondfireId: string): boolean {
  const lastViewed = viewedBondfires$[bondfireId].get()
  if (!lastViewed) return false
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
  return lastViewed > oneDayAgo
}

export function markViewed(bondfireId: string): void {
  viewedBondfires$[bondfireId].set(Date.now())
}
