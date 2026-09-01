import { describe, expect, it } from 'vitest'
import { calculateAgeAt, getAgeBand, getCampAgeBand, isUserEligibleForCamp } from './agePolicy'

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
