import { createElement, StrictMode } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DeviceAgeRange } from '../../../convex/agePolicy'
import { useDeviceAgeRecheck } from '../lib/useDeviceAgeRecheck'
import { useRegistrationAge } from '../lib/useRegistrationAge'

const mocks = vi.hoisted(() => ({
  request: vi.fn<() => Promise<DeviceAgeRange | null>>(),
  save: vi.fn(),
  records: new Map<string, string>(),
  listeners: new Set<(state: string) => void>(),
  appState: 'active',
}))
vi.mock('../lib/deviceAgeRange', () => ({ requestDeviceAgeRange: mocks.request }))
vi.mock('convex/react', () => ({ useMutation: () => mocks.save }))
vi.mock('@bondfires/app', () => ({
  mmkvStorage: {
    getItem: (key: string) => mocks.records.get(key),
    setItem: (key: string, value: string) => mocks.records.set(key, value),
  },
  telemetry: { warn: vi.fn() },
}))
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mocks.appState
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener)
      return { remove: () => mocks.listeners.delete(listener) }
    },
  },
}))

const first = 'first' as Id<'users'>
const second = 'second' as Id<'users'>
const adult: DeviceAgeRange = { source: 'apple_declared_age_range', lowerBound: 18 }
let renderer: ReturnType<typeof create>
let registration: ReturnType<typeof useRegistrationAge>

function Signup({ enabled }: { enabled: boolean }) {
  registration = useRegistrationAge(enabled)
  return null
}
function Recheck(props: Parameters<typeof useDeviceAgeRecheck>[0]) {
  useDeviceAgeRecheck(props)
  return null
}
async function foreground() {
  mocks.appState = 'active'
  await act(async () => {
    for (const listener of mocks.listeners) listener('active')
  })
}
function deferred() {
  let resolve!: (value: DeviceAgeRange | null) => void
  const promise = new Promise<DeviceAgeRange | null>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.records.clear()
  mocks.listeners.clear()
  mocks.appState = 'active'
  mocks.request.mockReset().mockResolvedValue(adult)
  mocks.save.mockReset().mockResolvedValue({ status: 'updated' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  vi.restoreAllMocks()
})

describe('registration device request', () => {
  it('finishes after Strict Mode effect replay without opening a second prompt', async () => {
    const pending = deferred()
    mocks.request.mockReturnValue(pending.promise)
    await act(async () => {
      renderer = create(createElement(StrictMode, null, createElement(Signup, { enabled: true })))
    })
    expect(registration.step).toBe('checking')
    await act(async () => pending.resolve(adult))
    expect(registration).toEqual({ step: 'adult', range: adult })
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('waits for pending registration and discards responses after leaving it', async () => {
    const pending = deferred()
    mocks.request.mockReturnValue(pending.promise)
    await act(async () => {
      renderer = create(createElement(Signup, { enabled: false }))
    })
    expect(mocks.request).not.toHaveBeenCalled()
    await act(async () => renderer.update(createElement(Signup, { enabled: true })))
    await act(async () => renderer.update(createElement(Signup, { enabled: false })))
    await act(async () => pending.resolve(adult))
    expect(registration.step).toBe('checking')
  })
})

describe('foreground device recheck', () => {
  it('requests once in Strict Mode and throttles only this account after saving', async () => {
    await act(async () => {
      renderer = create(createElement(StrictMode, null, createElement(Recheck, { userId: first })))
    })
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledWith({ expectedUserId: first, deviceAgeRange: adult })
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
    await act(async () => renderer.update(createElement(Recheck, { userId: second })))
    expect(mocks.save).toHaveBeenLastCalledWith({ expectedUserId: second, deviceAgeRange: adult })
    expect(mocks.records.size).toBe(2)
  })

  it.each([null, second])(
    'discards a pending response when the account changes to %s',
    async (next) => {
      const pending = deferred()
      mocks.request.mockReturnValueOnce(pending.promise).mockResolvedValue(null)
      await act(async () => {
        renderer = create(createElement(Recheck, { userId: first }))
      })
      await act(async () => renderer.update(createElement(Recheck, { userId: next })))
      await act(async () => pending.resolve(adult))
      expect(mocks.save).not.toHaveBeenCalled()
      expect(mocks.records.has(`device-age-recheck:${first}`)).toBe(false)
    },
  )

  it('retries on foreground after a failed save and suppresses overlapping requests', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(adult))
    expect(mocks.records.size).toBe(0)
    await foreground()
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.records.size).toBe(1)
  })

  it('retries saving an under-13 answer without asking the device to replace it', async () => {
    const child: DeviceAgeRange = { source: 'play_age_signals', lowerBound: 0, upperBound: 12 }
    mocks.request.mockResolvedValueOnce(child).mockResolvedValue(null)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    expect(mocks.records.size).toBe(0)
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save).toHaveBeenLastCalledWith({ expectedUserId: first, deviceAgeRange: child })
    expect(JSON.parse(mocks.records.get(`device-age-recheck:${first}`) ?? 'null')).toMatchObject({
      answered: true,
    })
  })

  it('does not reuse an unsaved answer after switching accounts', async () => {
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    mocks.request.mockResolvedValueOnce(adult).mockResolvedValue(null)
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    await act(async () => renderer.update(createElement(Recheck, { userId: second })))
    await foreground()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.records.has(`device-age-recheck:${first}`)).toBe(false)
  })

  it('waits for the foreground before opening a device prompt', async () => {
    mocks.appState = 'background'
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    expect(mocks.request).not.toHaveBeenCalled()
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('keeps an outstanding answer when the server check timestamp changes', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise).mockResolvedValue(null)
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    await act(async () =>
      renderer.update(createElement(Recheck, { userId: first, checkedAt: Date.now() })),
    )
    await act(async () => pending.resolve(adult))
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.save).toHaveBeenCalledWith({ expectedUserId: first, deviceAgeRange: adult })
  })

  it('uses the saved server check to avoid prompting again immediately after signup', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first, checkedAt: now }))
    })
    expect(mocks.request).not.toHaveBeenCalled()
    vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60 * 1000)
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('keeps silent results local and waits a week before asking again', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.request.mockResolvedValue(null)
    await act(async () => {
      renderer = create(createElement(Recheck, { userId: first }))
    })
    expect(mocks.save).not.toHaveBeenCalled()
    vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60 * 1000)
    await foreground()
    expect(mocks.request).toHaveBeenCalledOnce()
    vi.mocked(Date.now).mockReturnValue(now + 7 * 24 * 60 * 60 * 1000)
    await foreground()
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })
})
