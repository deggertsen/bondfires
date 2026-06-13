import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'

interface UserNameFields {
  displayName?: string | null
  name?: string | null
}

/**
 * Default title for a freshly recorded bondfire: the creator's first name
 * plus the first two words of the camp name (e.g. "Jake - Workout Warriors").
 *
 * Moved out of the deleted SparkTitleSheet so both the live-publish provision
 * step (set at creation) and the post-record completion screen (pre-filled,
 * editable) produce identical titles.
 */
export function getDefaultBondfireTitle(
  user: UserNameFields | null | undefined,
  campName?: string,
): string {
  const firstName = user?.displayName?.split(' ')[0] ?? user?.name?.split(' ')[0] ?? ''
  const campTwoWords = campName ? campName.trim().split(/\s+/).slice(0, 2).join(' ') : ''
  if (firstName && campTwoWords) return `${firstName} - ${campTwoWords}`
  if (firstName) return firstName
  return ''
}

/** Hook form of {@link getDefaultBondfireTitle} for the current user. */
export function useDefaultBondfireTitle(campName?: string): string {
  const currentUser = useQuery(api.users.current)
  return getDefaultBondfireTitle(currentUser, campName)
}
