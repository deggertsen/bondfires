import { afterEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }))
vi.mock('expo-device', () => ({
  modelName: 'test',
  osVersion: '1',
  osName: 'iOS',
  manufacturer: 'test',
  brand: 'test',
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: vi.fn() },
}))
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => storage.get(key),
    set: (key: string, value: string) => storage.set(key, value),
    remove: (key: string) => storage.delete(key),
  }),
}))

describe('persisted telemetry privacy', () => {
  const originalError = console.error
  const originalWarn = console.warn
  afterEach(() => {
    console.error = originalError
    console.warn = originalWarn
    vi.useRealTimers()
    storage.clear()
  })

  it('rewrites a same-length legacy queue before auth and never uploads the local account marker', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    storage.set(
      'queue',
      JSON.stringify([
        {
          level: 'error',
          event: 'test',
          message: 'person@example.com',
          data: { safe: 'family-0123456789ab4def89ab0123456789ab' },
          platform: 'ios',
          createdAt: Date.now(),
          localUserId: 'owner',
        },
      ]),
    )
    const { telemetry } = await import('../../../packages/app/src/services/telemetry')
    const createBatch = vi.fn(async () => {})
    telemetry.init({ create: vi.fn(), createBatch })
    const persisted = storage.get('queue') ?? ''
    expect(JSON.parse(persisted)).toHaveLength(1)
    expect(persisted).not.toContain('person@example.com')
    expect(persisted).not.toContain('family-')
    telemetry.setUserId('owner')
    await telemetry.flush()
    const payload = JSON.stringify(createBatch.mock.calls)
    expect(payload).not.toContain('localUserId')
    expect(payload).not.toContain('person@example.com')
    expect(createBatch).toHaveBeenCalledOnce()
  })

  it('scrubs the synchronous crash breadcrumb before writing it to disk', async () => {
    vi.resetModules()
    const { telemetry } = await import('../../../packages/app/src/services/telemetry')
    telemetry.setCrashBreadcrumb('person@example.com', { url: 'https://media.example/private' })
    const persisted = storage.get('last-crash-breadcrumb') ?? ''
    expect(persisted).toContain('[Redacted]')
    expect(persisted).not.toContain('person@example.com')
    expect(persisted).not.toContain('media.example')
  })
})
