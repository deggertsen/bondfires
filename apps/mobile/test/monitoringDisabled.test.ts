import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.2.3', extra: { appEnvironment: 'development' } },
    nativeBuildVersion: '42',
  },
}))

vi.mock('@sentry/react-native', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  wrap: vi.fn((component) => component),
}))

describe('monitoring configuration', () => {
  it('stays disabled when the DSN is absent', async () => {
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '')
    vi.resetModules()
    const Sentry = await import('@sentry/react-native')
    vi.mocked(Sentry.init).mockClear()
    const { getMonitoringConfig } = await import('../lib/monitoring')
    expect(getMonitoringConfig({})).toMatchObject({
      enabled: false,
      environment: 'development',
      release: 'org.bondfires@1.2.3',
      dist: '42',
    })
    expect(Sentry.init).not.toHaveBeenCalled()
  })
})
