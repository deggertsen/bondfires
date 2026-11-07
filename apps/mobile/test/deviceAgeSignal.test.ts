import { describe, expect, it } from 'vitest'
import {
  birthMonthFromControls,
  DEVICE_AGE_RECHECK_INTERVAL_MS,
  decideRegistrationAgeStep,
  deviceAgeRangeFromSignal,
  deviceAgeSourceForPlatform,
  resolveDeviceAgeRange,
  shouldRecheckDeviceAge,
} from '../lib/deviceAgeSignal'

const apple = 'apple_declared_age_range'
const play = 'play_age_signals'

describe('device age signal decision', () => {
  it('asks for month and year when the user declines or the native module throws', async () => {
    const declined = await resolveDeviceAgeRange(async () => ({ status: 'declined' }), apple)
    expect(declined).toBeNull()
    expect(decideRegistrationAgeStep(declined)).toBe('ask')

    const thrown = await resolveDeviceAgeRange(async () => {
      throw new Error('Cannot find native module BondfireAgeSignal')
    }, play)
    expect(thrown).toBeNull()
    expect(decideRegistrationAgeStep(thrown)).toBe('ask')

    const unavailable = await resolveDeviceAgeRange(async () => ({ status: 'unavailable' }), apple)
    expect(decideRegistrationAgeStep(unavailable)).toBe('ask')
    // Shared, but with no bounds at all: still nothing to rely on.
    expect(
      decideRegistrationAgeStep(
        deviceAgeRangeFromSignal({ status: 'shared', lowerBound: null, upperBound: null }, play),
      ),
    ).toBe('ask')
    // No supported platform: never pretend a signal existed.
    expect(
      await resolveDeviceAgeRange(async () => ({ status: 'shared', lowerBound: 18 }), null),
    ).toBeNull()
    expect(deviceAgeSourceForPlatform('web')).toBeNull()
  })

  it('does not ask when the device answers', async () => {
    const adult = await resolveDeviceAgeRange(
      async () => ({ status: 'shared', lowerBound: 18, upperBound: null }),
      apple,
    )
    expect(adult).toEqual({ source: apple, lowerBound: 18, upperBound: null })
    expect(decideRegistrationAgeStep(adult)).toBe('adult')

    const teen = await resolveDeviceAgeRange(
      async () => ({ status: 'shared', lowerBound: 16, upperBound: 17 }),
      play,
    )
    expect(decideRegistrationAgeStep(teen)).toBe('teen')
    expect(decideRegistrationAgeStep({ source: play, lowerBound: 13, upperBound: 15 })).toBe('teen')
    // Straddling 18 stays teen; the user is never asked to confirm a date.
    expect(decideRegistrationAgeStep({ source: apple, lowerBound: 16, upperBound: 20 })).toBe(
      'teen',
    )
  })

  it('blocks under-13 ranges without offering the month form', async () => {
    const child = await resolveDeviceAgeRange(
      async () => ({ status: 'shared', lowerBound: null, upperBound: 12 }),
      apple,
    )
    expect(decideRegistrationAgeStep(child)).toBe('blocked')
    expect(decideRegistrationAgeStep({ source: play, lowerBound: 0, upperBound: 12 })).toBe(
      'blocked',
    )
    expect(decideRegistrationAgeStep({ source: play, lowerBound: 10, upperBound: 15 })).toBe(
      'blocked',
    )
  })

  it('builds YYYY-MM only from complete month and year controls', () => {
    expect(birthMonthFromControls(null, '2008')).toBeNull()
    expect(birthMonthFromControls(3, '')).toBeNull()
    expect(birthMonthFromControls(3, '08')).toBeNull()
    expect(birthMonthFromControls(13, '2008')).toBeNull()
    expect(birthMonthFromControls(3, '2008')).toBe('2008-03')
    expect(birthMonthFromControls(12, '2008')).toBe('2008-12')
  })

  it('re-checks daily after an answer and weekly while the phone stays silent', () => {
    const now = Date.now()
    expect(shouldRecheckDeviceAge(null, now)).toBe(true)
    expect(shouldRecheckDeviceAge({ attemptedAt: now - 1000, answered: true }, now)).toBe(false)
    expect(
      shouldRecheckDeviceAge(
        { attemptedAt: now - DEVICE_AGE_RECHECK_INTERVAL_MS.answered, answered: true },
        now,
      ),
    ).toBe(true)
    expect(
      shouldRecheckDeviceAge(
        { attemptedAt: now - DEVICE_AGE_RECHECK_INTERVAL_MS.answered, answered: false },
        now,
      ),
    ).toBe(false)
    expect(
      shouldRecheckDeviceAge(
        { attemptedAt: now - DEVICE_AGE_RECHECK_INTERVAL_MS.silent, answered: false },
        now,
      ),
    ).toBe(true)
  })
})
