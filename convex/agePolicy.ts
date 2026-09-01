import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { throwUserError } from './errors'

export type AgeBand = 'teen' | 'adult'

const MINIMUM_AGE = 13
const ADULT_AGE = 18

export function parseBirthDate(birthDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/** Calculate age from a calendar date. UTC keeps birthday boundaries consistent worldwide. */
export function calculateAgeAt(birthDate: string, now = new Date()): number | null {
  const birth = parseBirthDate(birthDate)
  if (!birth) return null

  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  const day = now.getUTCDate()
  let age = year - birth.year
  if (month < birth.month || (month === birth.month && day < birth.day)) age -= 1
  return age
}

/** Missing, malformed, future, and under-13 dates are deliberately ineligible. */
export function getAgeBand(birthDate: string | undefined, now = new Date()): AgeBand | null {
  if (!birthDate) return null
  // DOB has no verified timezone. Evaluate against the previous UTC calendar
  // day so a user can never cross 13 or 18 early in a negative UTC offset.
  // This intentionally keeps them in the younger band for the full UTC
  // anniversary day (at most a conservative one-day delay).
  const priorUtcDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  )
  const age = calculateAgeAt(birthDate, priorUtcDay)
  if (age === null || age < MINIMUM_AGE) return null
  return age < ADULT_AGE ? 'teen' : 'adult'
}

export function getUserAgeBand(user: Pick<Doc<'users'>, 'birthDate'>, now = new Date()) {
  return getAgeBand(user.birthDate, now)
}

/** Legacy camps are adult-only until the explicit production backfill assigns a band. */
export function getCampAgeBand(camp: Pick<Doc<'camps'>, 'ageBand'>): AgeBand {
  return camp.ageBand ?? 'adult'
}

/** Legacy Hearths are adult-only until reconciled from their owner's persisted DOB. */
export function getPersonalCampAgeBand(camp: Pick<Doc<'personalCamps'>, 'ageBand'>): AgeBand {
  return camp.ageBand ?? 'adult'
}

export function isUserEligibleForCamp(
  user: Pick<Doc<'users'>, 'birthDate'> | null,
  camp: Pick<Doc<'camps'>, 'ageBand'>,
  now = new Date(),
) {
  return user !== null && getUserAgeBand(user, now) === getCampAgeBand(camp)
}

export function assertUserAgeBand(user: Pick<Doc<'users'>, 'birthDate'>): AgeBand {
  const band = getUserAgeBand(user)
  if (!band) {
    throwUserError('A valid birth date for someone age 13 or older is required.')
  }
  return band
}

export function assertUserCanAccessCamp(
  user: Pick<Doc<'users'>, 'birthDate'>,
  camp: Pick<Doc<'camps'>, 'ageBand'>,
) {
  if (assertUserAgeBand(user) !== getCampAgeBand(camp)) {
    throwUserError('This camp is only available to members in a different age group.')
  }
}

export async function assertUsersShareAgeBand(
  ctx: QueryCtx | MutationCtx,
  firstUserId: Doc<'users'>['_id'],
  secondUserId: Doc<'users'>['_id'],
) {
  const [first, second] = await Promise.all([ctx.db.get(firstUserId), ctx.db.get(secondUserId)])
  if (!first || !second || assertUserAgeBand(first) !== assertUserAgeBand(second)) {
    throwUserError('Invites can only be sent to people in your age group.')
  }
}
