import { useState } from 'react'

/** Keep Home's resolved rail while its focus-scoped subscription is paused. */
export function useHomeFeedSnapshot<T>(userId: string | null, liveValue: T | undefined) {
  const [snapshot, setSnapshot] = useState({ userId, value: liveValue })

  // Update during render so a user change cannot paint another user's snapshot.
  // Undefined means pending/skipped; an empty result is authoritative.
  if (snapshot.userId !== userId || (liveValue !== undefined && snapshot.value !== liveValue)) {
    setSnapshot({ userId, value: liveValue })
  }

  if (!userId) return undefined
  return liveValue ?? (snapshot.userId === userId ? snapshot.value : undefined)
}
