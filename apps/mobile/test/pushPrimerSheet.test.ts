import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushPermissionState } from '../../../packages/app/src/utils/pushNudge'
import { PushPrimerSheet } from '../components/PushPrimerSheet'

const mocks = vi.hoisted(() => ({
  eligible: true,
  physical: true,
  enabled: true,
  permission: vi.fn<() => Promise<PushPermissionState | null>>(),
  request: vi.fn<() => Promise<boolean>>(),
  release: vi.fn(),
  accepted: vi.fn(),
  declined: vi.fn(),
  openSettings: vi.fn(),
  returnToApp: vi.fn(),
  cancelReturn: vi.fn(),
}))

vi.mock('@bondfires/app', async () => ({
  ...(await import('../../../packages/app/src/utils/pushNudge')),
  appActions: {
    shouldShowPushPrimer: () => mocks.eligible,
    claimPushPrimer: () => {
      if (!mocks.eligible) return null
      mocks.eligible = false
      return mocks.release
    },
    recordPushPrimerAccepted: mocks.accepted,
    recordPushPrimerDeclined: mocks.declined,
  },
  appStore$: { preferences: { notificationsEnabled: { peek: () => mocks.enabled } } },
  getPushPermissionState: mocks.permission,
  requestPushPermission: mocks.request,
  onReturnToApp: mocks.returnToApp,
  telemetry: { breadcrumb: vi.fn(), warn: vi.fn() },
}))
vi.mock('@bondfires/ui', () => ({ Button: 'Button', Text: 'Text' }))
vi.mock('@tamagui/lucide-icons', () => ({ Bell: 'Bell', BellOff: 'BellOff' }))
vi.mock('expo-device', () => ({
  get isDevice() {
    return mocks.physical
  },
}))
vi.mock('react-native', () => ({
  Linking: { openSettings: mocks.openSettings },
  Platform: { OS: 'android' },
}))
vi.mock('tamagui', async () => {
  const { createElement } = await import('react')
  const Sheet = Object.assign((props: Record<string, unknown>) => createElement('Sheet', props), {
    Overlay: 'Overlay',
    Frame: 'Frame',
  })
  return { Sheet, YStack: 'YStack' }
})

const denied = { status: 'denied', granted: false, canAskAgain: true }

describe('PushPrimerSheet lifecycle', () => {
  let renderer: ReturnType<typeof create> | undefined
  const sheet = () => renderer.root.findByType('Sheet')
  async function render(trigger: boolean) {
    await act(async () => {
      const element = createElement(PushPrimerSheet, { trigger, context: 'feed' })
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }
  async function pressPrimary() {
    await act(async () => renderer.root.findAllByType('Button')[0].props.onPress())
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.eligible = true
    mocks.physical = true
    mocks.enabled = true
    mocks.permission.mockResolvedValue(denied)
    mocks.request.mockResolvedValue(false)
    mocks.openSettings.mockResolvedValue(undefined)
    mocks.returnToApp.mockReturnValue(mocks.cancelReturn)
    mocks.release.mockImplementation(() => {
      mocks.eligible = true
    })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
    renderer = undefined
  })

  it('closes when blocked without counting a decline or asking again this session', async () => {
    await render(true)
    expect(sheet().props.open).toBe(true)
    await render(false)
    expect(sheet().props.open).toBe(false)
    // A native close callback can follow a programmatic dismissal.
    await act(async () => sheet().props.onOpenChange(false))
    expect(mocks.declined).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
    await render(true)
    expect(sheet().props.open).toBe(false)
    expect(mocks.permission).toHaveBeenCalledOnce()
  })

  it('ignores a late permission result and returns an unused claim when blocked', async () => {
    let resolvePermission: (permission: PushPermissionState) => void = () => {}
    mocks.permission.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve
      }),
    )
    await render(true)
    await render(false)
    expect(mocks.release).toHaveBeenCalledOnce()
    await act(async () => resolvePermission(denied))
    expect(sheet().props.open).toBe(false)
    await render(true)
    expect(sheet().props.open).toBe(true)
  })

  it('releases a pending claim on unmount', async () => {
    mocks.permission.mockReturnValue(new Promise(() => {}))
    await render(true)
    await act(async () => renderer.unmount())
    renderer = undefined
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it.each([null, { status: 'granted', granted: true, canAskAgain: true }])(
    'does not consume the session when permission is unavailable or already granted: %j',
    async (permission) => {
      mocks.permission.mockResolvedValue(permission)
      await render(true)
      expect(sheet().props.open).toBe(false)
      expect(mocks.release).toHaveBeenCalledOnce()
    },
  )

  it.each(['physical', 'enabled', 'eligible'] as const)(
    'does not prompt when %s is false',
    async (key) => {
      mocks[key] = false
      await render(true)
      expect(mocks.permission).not.toHaveBeenCalled()
      expect(sheet().props.open).toBe(false)
    },
  )

  it.each([true, false])('records acceptance only for an OS grant (%s)', async (granted) => {
    mocks.request.mockResolvedValue(granted)
    await render(true)
    await pressPrimary()
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(mocks.accepted).toHaveBeenCalledTimes(granted ? 1 : 0)
    expect(mocks.openSettings).not.toHaveBeenCalled()
    expect(mocks.declined).not.toHaveBeenCalled()
    expect(sheet().props.open).toBe(false)
  })

  it.each([true, false])(
    'opens Settings without prompting and settles the return (%s)',
    async (granted) => {
      mocks.permission.mockResolvedValue({ ...denied, canAskAgain: false })
      await render(true)
      expect(JSON.stringify(renderer.toJSON())).toContain('Open Settings')
      await pressPrimary()
      expect(mocks.openSettings).toHaveBeenCalledOnce()
      expect(mocks.request).not.toHaveBeenCalled()
      mocks.permission.mockResolvedValue({
        status: granted ? 'granted' : 'denied',
        granted,
        canAskAgain: false,
      })
      await act(async () => mocks.returnToApp.mock.calls[0][0]())
      expect(mocks.accepted).toHaveBeenCalledTimes(granted ? 1 : 0)
      expect(mocks.declined).toHaveBeenCalledTimes(granted ? 0 : 1)
    },
  )

  it('cancels the return listener if opening Settings fails', async () => {
    mocks.permission.mockResolvedValue({ ...denied, canAskAgain: false })
    mocks.openSettings.mockRejectedValue(new Error('Settings unavailable'))
    await render(true)
    await pressPrimary()
    expect(mocks.cancelReturn).toHaveBeenCalledOnce()
    expect(mocks.accepted).not.toHaveBeenCalled()
  })

  it('counts a user dismissal once', async () => {
    await render(true)
    await act(async () => {
      sheet().props.onOpenChange(false)
      sheet().props.onOpenChange(false)
    })
    expect(mocks.declined).toHaveBeenCalledOnce()
    expect(sheet().props.open).toBe(false)
  })
})
