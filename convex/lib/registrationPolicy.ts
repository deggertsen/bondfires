import type { Doc } from '../_generated/dataModel'
import { getAgeBand } from '../agePolicy'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from '../contentSafety'

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
  const birthDate = typeof params.birthDate === 'string' ? params.birthDate.trim() : ''
  if (!getAgeBand(birthDate, now)) {
    throw new Error('A valid birth date for someone age 13 or older is required.')
  }
  if (params.acceptedLegal !== true && params.acceptedLegal !== 'true') {
    throw new Error('You must accept the Terms and Community Guidelines.')
  }
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    gender,
    birthDate,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
    acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    legalAcceptedAt: now.getTime(),
    registrationPending: false,
  } as const
}

export function canUseApp(user: Doc<'users'> | null) {
  return !!user && !user.accountDeletionStatus && user.registrationPending !== true
}

// The browser receives a one-time Convex code, never provider tokens. Only this
// exact app callback is accepted; post-registration navigation is kept locally.
export const MOBILE_AUTH_CALLBACK = 'bondfires://auth-callback'
export function authRedirect(redirectTo: string) {
  if (redirectTo !== MOBILE_AUTH_CALLBACK) throw new Error('Invalid authentication redirect')
  return redirectTo
}
