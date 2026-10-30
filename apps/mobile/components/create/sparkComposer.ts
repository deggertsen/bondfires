import type { Id } from '../../../../convex/_generated/dataModel'
import type { TradeTag } from './shared'

/** Which half of the Spark composer is active. */
export type SparkMode = 'people' | 'camp'

/** Above this many pickable camps the camp sheet gets a search field. */
export const CAMP_SEARCH_THRESHOLD = 3

/** How many joinable camps the no-camps empty state suggests. */
export const SUGGESTED_CAMP_LIMIT = 3

/** The camp fields the composer reads — a structural subset of `camps.list` rows. */
export interface ComposerCamp {
  _id: Id<'camps'>
  name: string
  slug: string
  access: 'open' | 'approval' | 'invite'
  membership: { status: string; role: string } | null
  rules: { access: { gender?: { value: string } } }
}

export interface CampPickerList<T extends ComposerCamp> {
  /** The persisted last-used camp, when it is still pickable. */
  lastUsed: T | null
  /** Every other pickable camp, A–Z. */
  others: T[]
  /** Camps awaiting approval — listed, but they can't be picked. */
  pending: T[]
  pickableCount: number
  showSearch: boolean
}

/**
 * The composer assumes existing connections: every entry opens on People
 * unless the caller already scoped the spark to a camp.
 */
export function resolveInitialSparkMode(params: { campId?: string }): SparkMode {
  return params.campId ? 'camp' : 'people'
}

/**
 * A camp you can start a fire in: an active member, and invite-only camps
 * only for their owner (everyone else can just respond there).
 */
export function isPickableCamp(camp: ComposerCamp): boolean {
  if (camp.membership?.status !== 'active') return false
  return camp.access !== 'invite' || camp.membership.role === 'owner'
}

const byName = (left: ComposerCamp, right: ComposerCamp) => left.name.localeCompare(right.name)

export function buildCampPickerList<T extends ComposerCamp>(
  camps: ReadonlyArray<T>,
  lastUsedCampId: string | null,
): CampPickerList<T> {
  const pickable = camps.filter(isPickableCamp).sort(byName)
  const lastUsed = pickable.find((camp) => camp._id === lastUsedCampId) ?? null
  return {
    lastUsed,
    others: pickable.filter((camp) => camp !== lastUsed),
    pending: camps.filter((camp) => camp.membership?.status === 'pending').sort(byName),
    pickableCount: pickable.length,
    showSearch: pickable.length > CAMP_SEARCH_THRESHOLD,
  }
}

/** Pickable camps in the order the sheet lists them: last used, then A–Z. */
export function orderedPickableCamps<T extends ComposerCamp>(list: CampPickerList<T>): T[] {
  return list.lastUsed ? [list.lastUsed, ...list.others] : list.others
}

export function filterCampsByName<T extends ComposerCamp>(
  camps: ReadonlyArray<T>,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...camps]
  return camps.filter((camp) => camp.name.toLowerCase().includes(needle))
}

/**
 * The camp the Camp tab shows. A pick made in the sheet wins, then the camp
 * the caller scoped the spark to, then the last-used camp, then the first in
 * the list. Ids that are no longer pickable fall through.
 */
export function resolveSelectedCampId(
  ordered: ReadonlyArray<ComposerCamp>,
  ids: {
    pickedCampId: string | null
    paramCampId: string | undefined
    lastUsedCampId: string | null
  },
): Id<'camps'> | null {
  for (const id of [ids.pickedCampId, ids.paramCampId, ids.lastUsedCampId]) {
    const match = id ? ordered.find((camp) => camp._id === id) : undefined
    if (match) return match._id
  }
  return ordered[0]?._id ?? null
}

/**
 * Camps to offer someone who isn't in any: launch-friendly Welcome Fires
 * first, then camps matching the user's gender rule, then by name.
 */
export function suggestCampsToJoin<T extends ComposerCamp>(
  camps: ReadonlyArray<T>,
  userGender: string | undefined,
  limit = SUGGESTED_CAMP_LIMIT,
): T[] {
  return camps
    .filter((camp) => !camp.membership && camp.access !== 'invite')
    .sort((left, right) => {
      const leftWelcome = left.slug.startsWith('welcome-fires') ? -1 : 0
      const rightWelcome = right.slug.startsWith('welcome-fires') ? -1 : 0
      if (leftWelcome !== rightWelcome) return leftWelcome - rightWelcome

      const leftMatch = userGender && left.rules.access.gender?.value === userGender ? -1 : 0
      const rightMatch = userGender && right.rules.access.gender?.value === userGender ? -1 : 0
      if (leftMatch !== rightMatch) return leftMatch - rightMatch

      return byName(left, right)
    })
    .slice(0, limit)
}

/** "Continue with Mom & Sam" once someone is chosen. */
export function buildPeopleCtaLabel(audienceSummary: string): string {
  return audienceSummary ? `Continue with ${audienceSummary}` : 'Continue to record'
}

export function buildCampCtaLabel(campName: string, tradeTag: TradeTag | null): string {
  return tradeTag ? `Record your ${tradeTag}` : `Record in ${campName}`
}

export function formatMemberCount(count: number | undefined): string | null {
  if (count === undefined) return null
  if (count === 1) return '1 member'
  if (count < 1000) return `${count} members`
  const thousands = (Math.floor(count / 100) / 10).toFixed(1).replace(/\.0$/, '')
  return `${thousands}k members`
}
