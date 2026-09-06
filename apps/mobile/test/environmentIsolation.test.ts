import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_CONVEX_URL,
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
} from '../config/environment.cjs'

describe('mobile environment ownership', () => {
  it('rejects profile/environment mismatches', () => {
    expect(() =>
      resolveAppEnvironment({ EAS_BUILD_PROFILE: 'preview', EXPO_PUBLIC_APP_ENV: 'production' }),
    ).toThrow(/must use preview/)
  })
  it('isolates the production Convex deployment', () => {
    expect(() =>
      validateConvexEnvironment({ appEnvironment: 'preview', convexUrl: PRODUCTION_CONVEX_URL }),
    ).toThrow(/must not use the production/)
    expect(() =>
      validateConvexEnvironment({
        appEnvironment: 'production',
        convexUrl: 'https://staging-example.convex.cloud',
      }),
    ).toThrow(/registered production/)
  })
  it('disables development collection even when requested', () => {
    expect(
      validateMonitoringEnvironment({
        appEnvironment: 'development',
        env: { CRASHLYTICS_ENABLED: 'true' },
        requireProduction: false,
      }).enabled,
    ).toBe(false)
  })
  it('requires explicit enablement and native privacy approval in production', () => {
    const check = (env: Record<string, string>) =>
      validateMonitoringEnvironment({ appEnvironment: 'production', env, requireProduction: true })
    expect(() => check({})).toThrow(/CRASHLYTICS_ENABLED/)
    expect(() => check({ CRASHLYTICS_ENABLED: 'true' })).toThrow(
      /MONITORING_NATIVE_PRIVACY_REVIEWED/,
    )
    expect(
      check({ CRASHLYTICS_ENABLED: 'true', MONITORING_NATIVE_PRIVACY_REVIEWED: 'true' }).enabled,
    ).toBe(true)
    expect(() => check({ CRASHLYTICS_ENABLED: 'yes' })).toThrow(/true or false/)
  })
  it('allows explicit preview collection before production privacy sign-off', () => {
    expect(
      validateMonitoringEnvironment({
        appEnvironment: 'preview',
        env: { CRASHLYTICS_ENABLED: 'true' },
        requireProduction: false,
      }).enabled,
    ).toBe(true)
  })
})
