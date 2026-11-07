import {
  type DeviceAgeRange,
  type DeviceAgeSource,
  getDeviceAgeOutcome,
} from '../../../convex/agePolicy'

/**
 * Pure decisions for the phone-first age flow. No React Native imports so the
 * rules are unit-testable; the native call lives in deviceAgeRange.ts.
 */

/** What the native module reports. Anything else is treated as unavailable. */
export type DeviceAgeSignalResult = {
  status: 'shared' | 'declined' | 'unavailable'
  lowerBound?: number | null
  upperBound?: number | null
}

export type RegistrationAgeStep = 'ask' | 'blocked' | 'teen' | 'adult'

/** Age gates sent to the device: the minimum age and the adult boundary. */
export const DEVICE_AGE_GATES = { minimum: 13, adult: 18 } as const

export function deviceAgeSourceForPlatform(os: string): DeviceAgeSource | null {
  if (os === 'ios') return 'apple_declared_age_range'
  if (os === 'android') return 'play_age_signals'
  return null
}

/** A shared signal with at least one bound becomes a range; declined/unavailable is null. */
export function deviceAgeRangeFromSignal(
  signal: DeviceAgeSignalResult | null | undefined,
  source: DeviceAgeSource | null,
): DeviceAgeRange | null {
  if (!signal || !source || signal.status !== 'shared') return null
  const lowerBound = typeof signal.lowerBound === 'number' ? signal.lowerBound : null
  const upperBound = typeof signal.upperBound === 'number' ? signal.upperBound : null
  if (lowerBound === null && upperBound === null) return null
  const range = { source, lowerBound, upperBound }
  return getDeviceAgeOutcome(range) === null ? null : range
}

/**
 * Ask the device, never throw. A declined prompt, an old OS, a missing module,
 * a Play Services error, or any other failure all mean "no signal" (null), so
 * the caller falls back to month/year without pretending a signal existed.
 */
export async function resolveDeviceAgeRange(
  request: () => Promise<DeviceAgeSignalResult>,
  source: DeviceAgeSource | null,
): Promise<DeviceAgeRange | null> {
  if (!source) return null
  try {
    return deviceAgeRangeFromSignal(await request(), source)
  } catch {
    return null
  }
}

/**
 * signal in → ask / block / teen / adult:
 * - no range: ask for month and year
 * - any part under 13 (including a range straddling 13): block, no month form
 * - 13–17, split teen ranges, or a range straddling 18: teen, no age form
 * - 18+: adult, no age form
 */
export function decideRegistrationAgeStep(range: DeviceAgeRange | null): RegistrationAgeStep {
  if (!range) return 'ask'
  const outcome = getDeviceAgeOutcome(range)
  if (outcome === null) return 'ask'
  if (outcome === 'under_13') return 'blocked'
  return outcome
}

/** Build `YYYY-MM` from the month/year controls; null until both are valid. */
export function birthMonthFromControls(month: number | null, year: string): string | null {
  if (month === null || month < 1 || month > 12) return null
  if (!/^\d{4}$/.test(year)) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

export type DeviceAgeRecheckRecord = { attemptedAt: number; answered: boolean }

/** Re-ask daily once the phone has answered; weekly while it stays silent. */
export const DEVICE_AGE_RECHECK_INTERVAL_MS = {
  answered: 24 * 60 * 60 * 1000,
  silent: 7 * 24 * 60 * 60 * 1000,
} as const

export function shouldRecheckDeviceAge(
  record: DeviceAgeRecheckRecord | null,
  now = Date.now(),
): boolean {
  if (!record) return true
  const interval = record.answered
    ? DEVICE_AGE_RECHECK_INTERVAL_MS.answered
    : DEVICE_AGE_RECHECK_INTERVAL_MS.silent
  return now - record.attemptedAt >= interval
}
