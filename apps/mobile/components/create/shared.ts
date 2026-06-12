import type { Doc } from '../../../../convex/_generated/dataModel'

export type TradeTag = 'need' | 'offer'
export type CampWithMembership = Doc<'camps'> & { membership: Doc<'campMembers'> | null }

export function formatRecordingClock(seconds: number) {
  const normalizedSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(normalizedSeconds / 60)
  const remainingSeconds = normalizedSeconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export function formatMaxDuration(seconds: number) {
  if (seconds % 60 === 0) {
    return `${Math.floor(seconds / 60)} min`
  }

  return formatRecordingClock(seconds)
}
