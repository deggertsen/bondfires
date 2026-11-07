import { describe, expect, it } from 'vitest'
import {
  birthMonthLastDay,
  calculateAgeAt,
  getAgeBand,
  getBirthMonthAgeBand,
  getCampAgeBand,
  getDeviceAgeBand,
  getDeviceAgeOutcome,
  getUserAgeBand,
  getUserMinimumAge,
  isUserEligibleForCamp,
} from './agePolicy'

const TODAY = new Date('2026-08-31T12:00:00.000Z')

describe('age-band policy', () => {
  it('uses conservative 13 and 18 birthday boundaries', () => {
    expect(getAgeBand('2013-08-31', TODAY)).toBeNull()
    expect(getAgeBand('2013-08-30', TODAY)).toBe('teen')
    expect(getAgeBand('2008-09-01', TODAY)).toBe('teen')
    expect(getAgeBand('2008-08-31', TODAY)).toBe('teen')
    expect(getAgeBand('2008-08-31', new Date('2026-09-01T00:00:00.000Z'))).toBe('adult')
    expect(calculateAgeAt('2008-09-01', TODAY)).toBe(17)
  })

  it('does not admit a 13-year-old early when they could still be 12 in UTC-12', () => {
    const birthDate = '2013-08-31'
    expect(getAgeBand(birthDate, new Date('2026-08-31T00:00:00.000Z'))).toBeNull()
    expect(getAgeBand(birthDate, new Date('2026-08-31T23:59:59.999Z'))).toBeNull()
    expect(getAgeBand(birthDate, new Date('2026-09-01T00:00:00.000Z'))).toBe('teen')
  })

  it('does not promote an 18-year-old early when they could still be 17 in UTC-12', () => {
    const birthDate = '2008-08-31'
    expect(getAgeBand(birthDate, new Date('2026-08-31T00:00:00.000Z'))).toBe('teen')
    expect(getAgeBand(birthDate, new Date('2026-08-31T23:59:59.999Z'))).toBe('teen')
    expect(getAgeBand(birthDate, new Date('2026-09-01T00:00:00.000Z'))).toBe('adult')
  })

  it('fails closed for missing, malformed, impossible, future, and under-13 dates', () => {
    expect(getAgeBand(undefined, TODAY)).toBeNull()
    expect(getAgeBand('not-a-date', TODAY)).toBeNull()
    expect(getAgeBand('2012-02-30', TODAY)).toBeNull()
    expect(getAgeBand('2030-01-01', TODAY)).toBeNull()
    expect(getAgeBand('2014-08-31', TODAY)).toBeNull()
  })

  it('treats legacy camps as adult-only', () => {
    expect(getCampAgeBand({ ageBand: undefined })).toBe('adult')
    expect(isUserEligibleForCamp({ birthDate: '2000-01-01' }, { ageBand: undefined }, TODAY)).toBe(
      true,
    )
    expect(isUserEligibleForCamp({ birthDate: '2010-01-01' }, { ageBand: undefined }, TODAY)).toBe(
      false,
    )
  })

  it('never permits mixed teen/adult camp access', () => {
    expect(isUserEligibleForCamp({ birthDate: '2010-01-01' }, { ageBand: 'teen' }, TODAY)).toBe(
      true,
    )
    expect(isUserEligibleForCamp({ birthDate: '2000-01-01' }, { ageBand: 'teen' }, TODAY)).toBe(
      false,
    )
    expect(isUserEligibleForCamp({ birthDate: '2010-01-01' }, { ageBand: 'adult' }, TODAY)).toBe(
      false,
    )
  })
})

describe('birth month fallback', () => {
  it('bands from the last day of the month under the same prior-UTC-day rule', () => {
    expect(birthMonthLastDay('2013-02')).toBe('2013-02-28')
    expect(birthMonthLastDay('2012-02')).toBe('2012-02-29')
    expect(birthMonthLastDay('2013-08')).toBe('2013-08-31')
    expect(birthMonthLastDay('2013-08-31')).toBeNull()
    // Someone born in August 2013 is 13 only once August 2026 is fully over,
    // exactly like a legacy birth date of 2013-08-31.
    expect(getBirthMonthAgeBand('2013-08', new Date('2026-08-01T12:00:00.000Z'))).toBeNull()
    expect(getBirthMonthAgeBand('2013-08', new Date('2026-08-30T12:00:00.000Z'))).toBeNull()
    expect(getBirthMonthAgeBand('2013-08', new Date('2026-08-31T23:59:59.999Z'))).toBeNull()
    expect(getBirthMonthAgeBand('2013-08', new Date('2026-09-01T00:00:00.000Z'))).toBe('teen')
    expect(getBirthMonthAgeBand('2013-08', new Date('2026-09-01T00:00:00.000Z'))).toBe(
      getAgeBand('2013-08-31', new Date('2026-09-01T00:00:00.000Z')),
    )
    expect(getBirthMonthAgeBand('2013-07', TODAY)).toBe('teen')
  })

  it('does not cross 18 during the birth month', () => {
    expect(getBirthMonthAgeBand('2008-08', new Date('2026-08-01T12:00:00.000Z'))).toBe('teen')
    expect(getBirthMonthAgeBand('2008-08', new Date('2026-08-31T23:59:59.999Z'))).toBe('teen')
    expect(getBirthMonthAgeBand('2008-08', new Date('2026-09-01T00:00:00.000Z'))).toBe('adult')
    expect(getBirthMonthAgeBand('2008-07', TODAY)).toBe('adult')
  })

  it('fails closed for missing, malformed, full-date, future, and under-13 months', () => {
    expect(getBirthMonthAgeBand(undefined, TODAY)).toBeNull()
    expect(getBirthMonthAgeBand('2000-13', TODAY)).toBeNull()
    expect(getBirthMonthAgeBand('2000-00', TODAY)).toBeNull()
    expect(getBirthMonthAgeBand('2000-01-01', TODAY)).toBeNull()
    expect(getBirthMonthAgeBand('2030-01', TODAY)).toBeNull()
    expect(getBirthMonthAgeBand('2014-08', TODAY)).toBeNull()
  })
})

describe('device age ranges', () => {
  const apple = 'apple_declared_age_range' as const
  const play = 'play_age_signals' as const

  it('maps Apple gates 13/18 and Play default bands onto teen and adult', () => {
    expect(getDeviceAgeOutcome({ source: apple, lowerBound: 13, upperBound: 17 })).toBe('teen')
    expect(getDeviceAgeOutcome({ source: apple, lowerBound: 18, upperBound: null })).toBe('adult')
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 13, upperBound: 15 })).toBe('teen')
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 16, upperBound: 17 })).toBe('teen')
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 18 })).toBe('adult')
  })

  it('blocks any range that includes someone under 13', () => {
    expect(getDeviceAgeOutcome({ source: apple, lowerBound: null, upperBound: 12 })).toBe(
      'under_13',
    )
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 0, upperBound: 12 })).toBe('under_13')
    // Straddling 13: still blocked.
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 10, upperBound: 15 })).toBe('under_13')
    expect(getDeviceAgeBand({ source: play, lowerBound: 10, upperBound: 15 })).toBeNull()
  })

  it('keeps a range that straddles 18 in the teen band', () => {
    expect(getDeviceAgeOutcome({ source: apple, lowerBound: 16, upperBound: 20 })).toBe('teen')
    expect(getDeviceAgeOutcome({ source: apple, lowerBound: 13, upperBound: null })).toBe('teen')
  })

  it('treats no bounds or nonsense as no signal', () => {
    expect(getDeviceAgeOutcome({ source: apple })).toBeNull()
    expect(getDeviceAgeOutcome({ source: play, lowerBound: null, upperBound: null })).toBeNull()
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 18, upperBound: 13 })).toBeNull()
    expect(getDeviceAgeOutcome({ source: play, lowerBound: 13.5 })).toBeNull()
  })
})

describe('user age resolution', () => {
  it('prefers a legacy birth date over anything else', () => {
    expect(
      getUserAgeBand(
        { birthDate: '2010-01-01', ageSource: 'apple_declared_age_range', deviceAgeBand: 'adult' },
        TODAY,
      ),
    ).toBe('teen')
    expect(getUserAgeBand({ birthDate: '2000-01-01', birthMonth: '2012-01' }, TODAY)).toBe('adult')
  })

  it('uses the stored device band only for device sources', () => {
    expect(getUserAgeBand({ ageSource: 'play_age_signals', deviceAgeBand: 'teen' }, TODAY)).toBe(
      'teen',
    )
    expect(getUserAgeBand({ ageSource: 'apple_declared_age_range' }, TODAY)).toBeNull()
    expect(getUserAgeBand({ ageSource: 'birth_month', deviceAgeBand: 'adult' }, TODAY)).toBeNull()
    expect(getUserAgeBand({ ageSource: 'birth_month', birthMonth: '2000-01' }, TODAY)).toBe('adult')
    expect(getUserAgeBand({ birthMonth: '2010-01' }, TODAY)).toBe('teen')
  })

  it('never admits a blocked account or an empty profile', () => {
    expect(getUserAgeBand({}, TODAY)).toBeNull()
    expect(
      getUserAgeBand({ ageSource: 'play_age_signals', deviceAgeBand: 'adult', ageBlockedAt: 1 }),
    ).toBeNull()
    expect(getUserAgeBand({ birthDate: '2000-01-01', ageBlockedAt: 1 })).toBeNull()
    expect(isUserEligibleForCamp({ birthMonth: '2010-01' }, { ageBand: 'teen' }, TODAY)).toBe(true)
    expect(isUserEligibleForCamp({ birthMonth: '2010-01' }, { ageBand: 'adult' }, TODAY)).toBe(
      false,
    )
  })

  it('reports only the age the stored data guarantees', () => {
    expect(getUserMinimumAge({ birthDate: '2000-01-01' }, TODAY)).toBe(26)
    expect(getUserMinimumAge({ birthMonth: '2008-08' }, new Date('2026-08-30T12:00:00.000Z'))).toBe(
      17,
    )
    expect(getUserMinimumAge({ birthMonth: '2008-08' }, TODAY)).toBe(18)
    expect(getUserMinimumAge({ ageSource: 'play_age_signals', deviceAgeBand: 'adult' })).toBe(18)
    expect(getUserMinimumAge({ ageSource: 'play_age_signals', deviceAgeBand: 'teen' })).toBe(13)
    expect(getUserMinimumAge({ ageSource: 'play_age_signals' })).toBeNull()
    expect(getUserMinimumAge({})).toBeNull()
  })
})
