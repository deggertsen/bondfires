import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_CONVEX_URL,
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
} from '../config/environment.cjs'

describe('mobile environment ownership', () => {
  const productionMonitoring = {
    EXPO_PUBLIC_SENTRY_DSN: 'https://public-key@o1.ingest.sentry.io/1234',
    SENTRY_ORG: 'bondfires',
    SENTRY_PROJECT: 'mobile',
    SENTRY_AUTH_TOKEN: 'synthetic-token',
    SENTRY_NATIVE_PRIVACY_REVIEWED: 'true',
  }

  it('requires a native-payload privacy review before production monitoring', () => {
    expect(() =>
      validateMonitoringEnvironment({
        appEnvironment: 'production',
        env: { ...productionMonitoring, SENTRY_NATIVE_PRIVACY_REVIEWED: undefined },
        requireProduction: true,
      }),
    ).toThrow(/SENTRY_NATIVE_PRIVACY_REVIEWED/)
  })

  it.each(['SENTRY_DISABLE_AUTO_UPLOAD', 'SENTRY_ALLOW_FAILURE'])(
    'rejects the source-map bypass %s',
    (key) => {
      expect(() =>
        validateMonitoringEnvironment({
          appEnvironment: 'production',
          env: { ...productionMonitoring, [key]: 'true' },
          requireProduction: true,
          requireSourceMaps: true,
        }),
      ).toThrow(/must not disable/)
    },
  )
  it('rejects profile/environment mismatches', () => {
    expect(() =>
      resolveAppEnvironment({ EAS_BUILD_PROFILE: 'preview', EXPO_PUBLIC_APP_ENV: 'production' }),
    ).toThrow(/must use preview/)
  })

  it('prevents non-production builds from using production Convex', () => {
    expect(() =>
      validateConvexEnvironment({
        appEnvironment: 'preview',
        convexUrl: PRODUCTION_CONVEX_URL,
      }),
    ).toThrow(/must not use the production/)
  })

  it('prevents production from using an unregistered deployment', () => {
    expect(() =>
      validateConvexEnvironment({
        appEnvironment: 'production',
        convexUrl: 'https://staging-example.convex.cloud',
      }),
    ).toThrow(/registered production/)
  })

  it('requires monitoring configuration only for production release builds', () => {
    expect(
      validateMonitoringEnvironment({
        appEnvironment: 'development',
        env: {},
        requireProduction: false,
      }).enabled,
    ).toBe(false)
    expect(() =>
      validateMonitoringEnvironment({
        appEnvironment: 'production',
        env: {},
        requireProduction: true,
      }),
    ).toThrow(/EXPO_PUBLIC_SENTRY_DSN/)
  })

  it('rejects malformed DSNs and production builds without source-map credentials', () => {
    expect(() =>
      validateMonitoringEnvironment({
        appEnvironment: 'production',
        env: {
          EXPO_PUBLIC_SENTRY_DSN: 'https://not-sentry.example/project',
          SENTRY_ORG: 'bondfires',
          SENTRY_PROJECT: 'mobile',
        },
        requireProduction: true,
      }),
    ).toThrow(/valid HTTPS sentry.io/)

    expect(() =>
      validateMonitoringEnvironment({
        appEnvironment: 'production',
        env: {
          EXPO_PUBLIC_SENTRY_DSN: 'https://public-key@o1.ingest.sentry.io/1234',
          SENTRY_ORG: 'bondfires',
          SENTRY_PROJECT: 'mobile',
        },
        requireProduction: true,
        requireSourceMaps: true,
      }),
    ).toThrow(/SENTRY_AUTH_TOKEN/)
  })
})
