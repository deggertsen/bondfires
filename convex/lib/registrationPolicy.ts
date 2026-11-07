import type { Doc } from '../_generated/dataModel'
import {
  type AgeBand,
  type AgeProfile,
  type DeviceAgeRange,
  type DeviceAgeSource,
  getBirthMonthAgeBand,
  getDeviceAgeOutcome,
  getUserAgeBand,
  isDeviceAgeSource,
  parseBirthMonth,
} from '../agePolicy'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from '../contentSafety'

export const UNDER_13_MESSAGE = 'Bondfires is only available to people age 13 or older.'

/** Age fields written at registration. Never a full birth date. */
export type RegistrationAgeFields =
  | { ageSource: DeviceAgeSource; deviceAgeBand: AgeBand; deviceAgeCheckedAt: number }
  | { ageSource: 'birth_month'; birthMonth: string }

function optionalBound(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid age range.')
  return value
}

/** Parse a client-sent device range. Returns null when nothing was sent. */
export function parseDeviceAgeRange(value: unknown): DeviceAgeRange | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error('Invalid age range.')
  const range = value as Record<string, unknown>
  if (!isDeviceAgeSource(range.source)) throw new Error('Invalid age range source.')
  return {
    source: range.source,
    lowerBound: optionalBound(range.lowerBound),
    upperBound: optionalBound(range.upperBound),
  }
}

/**
 * Phone-first age input for new registrations:
 * - a device range decides alone; under 13 is rejected even if a month is
 *   also sent, and an eligible range stores only the device source and band
 * - with no usable device range, a `YYYY-MM` birth month is required and
 *   banded from the end of the month
 * - a full `YYYY-MM-DD` is never accepted from new users
 */
export function registrationAgeFields(
  params: Record<string, unknown>,
  now = new Date(),
): RegistrationAgeFields {
  if (typeof params.birthDate === 'string' && params.birthDate.trim() !== '') {
    throw new Error('Only a birth month and year can be provided.')
  }
  const device = parseDeviceAgeRange(params.deviceAgeRange)
  const outcome = device ? getDeviceAgeOutcome(device) : null
  if (outcome === 'under_13') throw new Error(UNDER_13_MESSAGE)
  if (device && outcome) {
    return { ageSource: device.source, deviceAgeBand: outcome, deviceAgeCheckedAt: now.getTime() }
  }
  const birthMonth = typeof params.birthMonth === 'string' ? params.birthMonth.trim() : ''
  if (!parseBirthMonth(birthMonth)) {
    throw new Error('Enter your birth month and year (YYYY-MM).')
  }
  if (!getBirthMonthAgeBand(birthMonth, now)) throw new Error(UNDER_13_MESSAGE)
  return { ageSource: 'birth_month', birthMonth }
}

export function registrationProfile(params: Record<string, unknown>, now = new Date()) {
  const firstName = typeof params.firstName === 'string' ? params.firstName.trim() : ''
  const lastName = typeof params.lastName === 'string' ? params.lastName.trim() : ''
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
    throw new Error('Enter your first and last name (up to 100 characters each).')
  }
  const gender = params.gender
  if (gender !== 'male' && gender !== 'female' && gender !== 'other') {
    throw new Error('Please select your gender.')
  }
  const age = registrationAgeFields(params, now)
  if (params.acceptedLegal !== true && params.acceptedLegal !== 'true') {
    throw new Error('You must accept the Terms and Community Guidelines.')
  }
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    gender,
    ...age,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
    acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    legalAcceptedAt: now.getTime(),
    registrationPending: false,
  } as const
}

/** A completed, non-deleting account that no device range has blocked. */
export function canUseApp(user: Doc<'users'> | null) {
  return (
    !!user && !user.accountDeletionStatus && user.registrationPending !== true && !user.ageBlockedAt
  )
}

/**
 * Launch / foreground re-check. A device range may graduate a teen to adult,
 * replace a stored birth month, or apply / lift an age block. It never moves an
 * adult account into the teen band (that needs a new teen account), never
 * touches a legacy birth date, and never accepts a month. Returns the patch.
 */
export function deviceAgeRecheckPatch(
  user: Pick<Doc<'users'>, 'registrationPending'> & AgeProfile,
  range: DeviceAgeRange,
  now = new Date(),
): { status: 'skipped' | 'updated' | 'blocked'; patch: Partial<Doc<'users'>> } {
  if (user.registrationPending === true || user.birthDate) return { status: 'skipped', patch: {} }
  const outcome = getDeviceAgeOutcome(range)
  if (outcome === null) return { status: 'skipped', patch: {} }
  const checkedAt = now.getTime()
  if (outcome === 'under_13') {
    if (user.ageBlockedAt) return { status: 'skipped', patch: {} }
    // Keep the stored band so lifting the block later still can't move an
    // adult account into the teen band.
    return {
      status: 'blocked',
      patch: { deviceAgeCheckedAt: checkedAt, ageBlockedAt: checkedAt, updatedAt: checkedAt },
    }
  }
  // The band the account holds, ignoring any block. Adult never becomes teen;
  // a blocked adult account whose phone now says teen stays blocked.
  const currentBand = getUserAgeBand({ ...user, ageBlockedAt: undefined }, now)
  if (currentBand === 'adult' && outcome === 'teen') return { status: 'skipped', patch: {} }
  return {
    status: 'updated',
    patch: {
      ageSource: range.source,
      birthMonth: undefined,
      deviceAgeBand: outcome,
      deviceAgeCheckedAt: checkedAt,
      ageBlockedAt: undefined,
      updatedAt: checkedAt,
    },
  }
}

// The browser receives a one-time Convex code, never provider tokens. Only this
// exact app callback is accepted; post-registration navigation is kept locally.
export const MOBILE_AUTH_CALLBACK = 'bondfires://auth-callback'
export function authRedirect(redirectTo: string) {
  if (redirectTo !== MOBILE_AUTH_CALLBACK) throw new Error('Invalid authentication redirect')
  return redirectTo
}
