import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { throwUserError } from './errors'

export type AgeBand = 'teen' | 'adult'

/** Where a user's age band currently comes from. */
export type AgeSource = NonNullable<Doc<'users'>['ageSource']>
export type DeviceAgeSource = Extract<AgeSource, 'apple_declared_age_range' | 'play_age_signals'>

/**
 * The subset of a user document that decides their age band. Every band
 * decision in the backend goes through this type so no caller can assume a
 * full birth date is the only input.
 */
export type AgeProfile = Pick<
  Doc<'users'>,
  'birthDate' | 'birthMonth' | 'ageSource' | 'deviceAgeBand' | 'ageBlockedAt'
>

/**
 * An age range reported by the device (Apple Declared Age Range or Google Play
 * Age Signals). Bounds are inclusive; a missing lower bound means the range
 * starts at birth and a missing upper bound means it is open-ended.
 */
export type DeviceAgeRange = {
  source: DeviceAgeSource
  lowerBound?: number | null
  upperBound?: number | null
}

/** Mapping of a device range onto the bands; null means the device gave nothing usable. */
export type DeviceAgeOutcome = AgeBand | 'under_13' | null

const MINIMUM_AGE = 13
const ADULT_AGE = 18
const DEVICE_AGE_SOURCES: ReadonlySet<string> = new Set([
  'apple_declared_age_range',
  'play_age_signals',
])

export function isDeviceAgeSource(source: unknown): source is DeviceAgeSource {
  return typeof source === 'string' && DEVICE_AGE_SOURCES.has(source)
}

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

/** `YYYY-MM` only. Returns null for a full date, a bad month, or anything else. */
export function parseBirthMonth(birthMonth: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(birthMonth)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1900 || month < 1 || month > 12) return null
  return { year, month }
}

/**
 * The latest possible birthday for someone born in this month. Banding from the
 * last day of the month keeps everyone in the younger band until the month is
 * fully over, so nobody born on the 1st is treated as older than they may be.
 */
export function birthMonthLastDay(birthMonth: string): string | null {
  const parsed = parseBirthMonth(birthMonth)
  if (!parsed) return null
  const lastDay = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate()
  return `${String(parsed.year).padStart(4, '0')}-${String(parsed.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
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

/** Month/year fallback: band from the last day of the month under the same prior-UTC-day rule. */
export function getBirthMonthAgeBand(
  birthMonth: string | undefined,
  now = new Date(),
): AgeBand | null {
  if (!birthMonth) return null
  const lastDay = birthMonthLastDay(birthMonth)
  return lastDay ? getAgeBand(lastDay, now) : null
}

/**
 * Map a device range onto the bands (age gates 13 and 18):
 * - no bounds at all → null (the device gave nothing; ask for month/year)
 * - any part of the range below 13 → 'under_13' (blocked, even if it also
 *   straddles 13 or 18)
 * - lower bound 13–17 → 'teen', including split ranges (13–15, 16–17) and
 *   ranges that straddle 18 (the user stays in the teen band)
 * - lower bound 18+ → 'adult'
 */
export function getDeviceAgeOutcome(range: DeviceAgeRange): DeviceAgeOutcome {
  const lower = range.lowerBound ?? null
  const upper = range.upperBound ?? null
  if (lower === null && upper === null) return null
  if (
    (lower !== null && (!Number.isSafeInteger(lower) || lower < 0)) ||
    (upper !== null && (!Number.isSafeInteger(upper) || upper < 0)) ||
    (lower !== null && upper !== null && upper < lower)
  ) {
    return null
  }
  const effectiveLower = lower ?? 0
  if (effectiveLower < MINIMUM_AGE) return 'under_13'
  return effectiveLower < ADULT_AGE ? 'teen' : 'adult'
}

/** Band from a device range, or null when the range is unusable or under 13. */
export function getDeviceAgeBand(range: DeviceAgeRange): AgeBand | null {
  const outcome = getDeviceAgeOutcome(range)
  return outcome === 'teen' || outcome === 'adult' ? outcome : null
}

/**
 * Single place that decides a user's age band:
 * 1. an age-blocked account is never eligible
 * 2. a legacy full birth date, when present, stays the source of truth
 * 3. a device-sourced band is used as stored (the device beat any month)
 * 4. a birth month is banded from its last day
 * Missing, malformed, and under-13 inputs stay ineligible (null).
 */
export function getUserAgeBand(user: AgeProfile, now = new Date()): AgeBand | null {
  if (user.ageBlockedAt) return null
  if (user.birthDate) return getAgeBand(user.birthDate, now)
  if (isDeviceAgeSource(user.ageSource)) return user.deviceAgeBand ?? null
  return getBirthMonthAgeBand(user.birthMonth, now)
}

/**
 * The lowest age the stored data guarantees, for exact-age camp rules and the
 * owner's profile. A device band only proves the band's floor (13 or 18).
 */
export function getUserMinimumAge(user: AgeProfile, now = new Date()): number | null {
  if (user.ageBlockedAt) return null
  if (user.birthDate) return calculateAgeAt(user.birthDate, now)
  if (isDeviceAgeSource(user.ageSource)) {
    if (user.deviceAgeBand === 'adult') return ADULT_AGE
    return user.deviceAgeBand === 'teen' ? MINIMUM_AGE : null
  }
  const lastDay = user.birthMonth ? birthMonthLastDay(user.birthMonth) : null
  return lastDay ? calculateAgeAt(lastDay, now) : null
}

/**
 * A minimum cannot prove a maximum-age rule. Months use the earliest possible
 * birthday; legacy dates remain exact. Stored device bands have no known
 * ceiling: even a teen band may have come from a range straddling 18.
 */
export function getUserMaximumAge(user: AgeProfile, now = new Date()): number | null {
  if (user.ageBlockedAt) return null
  if (user.birthDate) return calculateAgeAt(user.birthDate, now)
  if (isDeviceAgeSource(user.ageSource)) return null
  if (!user.birthMonth || !parseBirthMonth(user.birthMonth)) return null
  return calculateAgeAt(`${user.birthMonth}-01`, now)
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
  user: AgeProfile | null,
  camp: Pick<Doc<'camps'>, 'ageBand'>,
  now = new Date(),
) {
  return user !== null && getUserAgeBand(user, now) === getCampAgeBand(camp)
}

export function assertUserAgeBand(user: AgeProfile): AgeBand {
  const band = getUserAgeBand(user)
  if (!band) {
    throwUserError('A valid birth date for someone age 13 or older is required.')
  }
  return band
}

export function assertUserCanAccessCamp(user: AgeProfile, camp: Pick<Doc<'camps'>, 'ageBand'>) {
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
