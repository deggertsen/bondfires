import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constants: {
    appOwnership: 'standalone',
    nativeBuildVersion: '42',
    expoConfig: {
      version: '1.2.3',
      extra: { appEnvironment: 'production', monitoringEnabled: true },
    },
  },
  platform: { OS: 'ios' },
  getCrashlytics: vi.fn(() => ({})),
  setAttributes: vi.fn(async () => {}),
  setCrashlyticsCollectionEnabled: vi.fn(async () => {}),
  recordError: vi.fn(),
  enable: vi.fn(),
}))
vi.mock('expo-constants', () => ({ default: mocks.constants }))
vi.mock('react-native', () => ({ Platform: mocks.platform }))
vi.mock('@react-native-firebase/crashlytics', () => mocks)
vi.mock('promise/setimmediate/rejection-tracking', () => ({ default: { enable: mocks.enable } }))

describe('Crashlytics adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.constants.expoConfig.extra = { appEnvironment: 'production', monitoringEnabled: true }
    mocks.constants.appOwnership = 'standalone'
    mocks.platform.OS = 'ios'
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['disabled', 'development', 'web', 'expo'])(
    'does not access the SDK in %s',
    async (mode) => {
      if (mode === 'disabled') mocks.constants.expoConfig.extra.monitoringEnabled = false
      if (mode === 'development') mocks.constants.expoConfig.extra.appEnvironment = 'development'
      if (mode === 'web') mocks.platform.OS = 'web'
      if (mode === 'expo') mocks.constants.appOwnership = 'expo'
      const monitoring = await import('../lib/monitoring')
      expect(await monitoring.initializeMonitoring()).toBe(false)
      monitoring.captureUnhandledException(new Error('not collected'))
      expect(mocks.getCrashlytics).not.toHaveBeenCalled()
      expect(mocks.recordError).not.toHaveBeenCalled()
    },
  )
  it('initializes once and tags before enabling native collection', async () => {
    const monitoring = await import('../lib/monitoring')
    expect(await monitoring.initializeMonitoring()).toBe(true)
    await monitoring.initializeMonitoring()
    expect(mocks.getCrashlytics).toHaveBeenCalledOnce()
    expect(mocks.setAttributes).toHaveBeenCalledWith(expect.anything(), {
      environment: 'production',
      release: 'org.bondfires@1.2.3',
      dist: '42',
    })
    expect(mocks.setAttributes.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setCrashlyticsCollectionEnabled.mock.invocationCallOrder[0],
    )
  })
  it('scrubs boundary, global and polyfill errors without swallowing the original handler', async () => {
    const original = vi.fn()
    const setGlobalHandler = vi.fn()
    vi.stubGlobal('ErrorUtils', { getGlobalHandler: () => original, setGlobalHandler })
    const monitoring = await import('../lib/monitoring')
    await monitoring.initializeMonitoring()
    const error = new Error('person@example.com')
    monitoring.captureUnhandledException(error)
    setGlobalHandler.mock.calls.at(-1)?.[0](error, true)
    mocks.enable.mock.calls.at(-1)?.[0].onUnhandled(1, error)
    expect(mocks.recordError).toHaveBeenCalledTimes(3)
    for (const [, captured] of mocks.recordError.mock.calls)
      expect(captured.message).not.toContain('person@example.com')
    expect(original).toHaveBeenCalledWith(error, true)
  })
  it('does not fail app startup if native configuration is unavailable', async () => {
    mocks.getCrashlytics.mockImplementationOnce(() => {
      throw new Error('missing native module')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const monitoring = await import('../lib/monitoring')
    expect(await monitoring.initializeMonitoring()).toBe(false)
    expect(mocks.setCrashlyticsCollectionEnabled).not.toHaveBeenCalled()
    warning.mockRestore()
  })
})
