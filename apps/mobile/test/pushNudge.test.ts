import { describe, expect, it, vi } from 'vitest'
import {
  canConsiderPushNudge,
  pushNudgeMode,
  requestPushFromNudge,
} from '../../../packages/app/src/utils/pushNudge'

describe('pushNudgeMode', () => {
  it('shows nothing once permission is granted', () => {
    expect(pushNudgeMode({ status: 'granted', granted: true, canAskAgain: true })).toBeNull()
  })

  it('requests when Android reports denied but the user was never asked', () => {
    expect(pushNudgeMode({ status: 'denied', granted: false, canAskAgain: true })).toBe('request')
  })

  it('requests when the status is undetermined even if canAskAgain is false', () => {
    expect(pushNudgeMode({ status: 'undetermined', granted: false, canAskAgain: false })).toBe(
      'request',
    )
  })

  it('points to Settings when the OS will no longer prompt', () => {
    expect(pushNudgeMode({ status: 'denied', granted: false, canAskAgain: false })).toBe('settings')
  })
})

describe('canConsiderPushNudge', () => {
  const eligible = { isPhysicalDevice: true, notificationsEnabled: true, primerEligible: true }

  it('allows a physical device with the preference on and the primer eligible', () => {
    expect(canConsiderPushNudge(eligible)).toBe(true)
  })

  it.each(['isPhysicalDevice', 'notificationsEnabled', 'primerEligible'] as const)(
    'blocks when %s is false',
    (key) => {
      expect(canConsiderPushNudge({ ...eligible, [key]: false })).toBe(false)
    },
  )
})

describe('requestPushFromNudge', () => {
  it('records accepted only after the OS grants permission', async () => {
    const recordAccepted = vi.fn()
    let resolveRequest: (granted: boolean) => void = () => {}
    const request = () =>
      new Promise<boolean>((resolve) => {
        resolveRequest = resolve
      })

    const pending = requestPushFromNudge(request, recordAccepted)
    expect(recordAccepted).not.toHaveBeenCalled()

    resolveRequest(true)
    await expect(pending).resolves.toBe(true)
    expect(recordAccepted).toHaveBeenCalledTimes(1)
  })

  it('leaves the primer un-accepted when the OS denies', async () => {
    const recordAccepted = vi.fn()
    await expect(requestPushFromNudge(async () => false, recordAccepted)).resolves.toBe(false)
    expect(recordAccepted).not.toHaveBeenCalled()
  })

  it('leaves the primer un-accepted when the request throws', async () => {
    const recordAccepted = vi.fn()
    await expect(
      requestPushFromNudge(async () => {
        throw new Error('boom')
      }, recordAccepted),
    ).rejects.toThrow('boom')
    expect(recordAccepted).not.toHaveBeenCalled()
  })
})
