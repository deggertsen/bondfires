import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import type { AgeProfile } from './agePolicy'
import { computeVisibility } from './camps'

function visibility(profile: AgeProfile, access: Doc<'camps'>['rules']['access']) {
  return computeVisibility(
    { tier: 'free', ageProfile: profile },
    {
      _id: 'camp' as Id<'camps'>,
      _creationTime: 1,
      slug: 'test',
      name: 'Test',
      purpose: 'Test age limits',
      access: 'open',
      status: 'active',
      ageBand: profile.deviceAgeBand ?? 'adult',
      rules: { access, participation: {}, advisory: {} },
      createdAt: 1,
      updatedAt: 1,
    },
  )
}

describe('camp age limits with partial age information', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('uses the device band floor for minimum ages, never for maximum ages', () => {
    const adult = { ageSource: 'play_age_signals', deviceAgeBand: 'adult' } as const
    expect(visibility(adult, { minAge: { value: 18, visibilityMode: 'hide' } }).visible).toBe(true)
    expect(visibility(adult, { minAge: { value: 21, visibilityMode: 'hide' } }).visible).toBe(false)
    expect(visibility(adult, { maxAge: { value: 25, visibilityMode: 'hide' } }).visible).toBe(false)
    // A teen band can originate from a straddling range, so it has no stored ceiling either.
    const teen = { ageSource: 'play_age_signals', deviceAgeBand: 'teen' } as const
    expect(visibility(teen, { maxAge: { value: 15, visibilityMode: 'hide' } }).visible).toBe(false)
    expect(visibility(teen, {}).visible).toBe(true)
  })

  it('uses both ends of the birth month when its anniversary spans two ages', () => {
    const month = { birthMonth: '2000-08', ageSource: 'birth_month' } as const
    expect(visibility(month, { minAge: { value: 26, visibilityMode: 'hide' } }).visible).toBe(false)
    expect(visibility(month, { maxAge: { value: 25, visibilityMode: 'hide' } }).visible).toBe(false)
    expect(visibility(month, { maxAge: { value: 26, visibilityMode: 'hide' } }).visible).toBe(true)
    expect(
      visibility({ birthDate: '2000-08-31' }, { maxAge: { value: 25, visibilityMode: 'hide' } })
        .visible,
    ).toBe(true)
  })
})
