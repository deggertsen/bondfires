import { describe, expect, it, vi } from 'vitest'
import {
  APP_SESSION_IDLE_MS,
  startsNewAppSession,
} from '../../../packages/app/src/utils/appSession'
import {
  canConsiderPushNudge,
  hasRecordedVideo,
  isPushPrimerEligible,
  PUSH_PRIMER_MAX_DECLINES,
  pushNudgeMode,
  requestPushFromNudge,
  settlePushSettingsReturn,
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

describe('isPushPrimerEligible', () => {
  const sessionStartedAt = 1_000_000
  const fresh = { lastShownAt: null, declineCount: 0, accepted: false }

  it('shows when it has never been shown', () => {
    expect(isPushPrimerEligible(fresh, sessionStartedAt)).toBe(true)
  })

  it('shows again in a new session', () => {
    expect(
      isPushPrimerEligible({ ...fresh, lastShownAt: sessionStartedAt - 1 }, sessionStartedAt),
    ).toBe(true)
  })

  it('shows at most once per session', () => {
    expect(
      isPushPrimerEligible({ ...fresh, lastShownAt: sessionStartedAt }, sessionStartedAt),
    ).toBe(false)
    expect(
      isPushPrimerEligible({ ...fresh, lastShownAt: sessionStartedAt + 5 }, sessionStartedAt),
    ).toBe(false)
  })

  it('stops after the decline cap', () => {
    expect(
      isPushPrimerEligible({ ...fresh, declineCount: PUSH_PRIMER_MAX_DECLINES }, sessionStartedAt),
    ).toBe(false)
    expect(
      isPushPrimerEligible(
        { ...fresh, declineCount: PUSH_PRIMER_MAX_DECLINES - 1 },
        sessionStartedAt,
      ),
    ).toBe(true)
  })

  it('never shows once accepted', () => {
    expect(isPushPrimerEligible({ ...fresh, accepted: true }, sessionStartedAt)).toBe(false)
  })
})

describe('hasRecordedVideo', () => {
  it('is false while the user is loading or has no videos', () => {
    expect(hasRecordedVideo(undefined)).toBe(false)
    expect(hasRecordedVideo(null)).toBe(false)
    expect(hasRecordedVideo({ bondfireCount: 0, responseCount: 0 })).toBe(false)
  })

  it('counts a started Bondfire or a response', () => {
    expect(hasRecordedVideo({ bondfireCount: 1, responseCount: 0 })).toBe(true)
    expect(hasRecordedVideo({ responseCount: 2 })).toBe(true)
  })
})

describe('settlePushSettingsReturn', () => {
  it('records accepted when the user came back with notifications allowed', () => {
    const actions = { recordAccepted: vi.fn(), recordDeclined: vi.fn() }
    settlePushSettingsReturn(true, actions)
    expect(actions.recordAccepted).toHaveBeenCalledTimes(1)
    expect(actions.recordDeclined).not.toHaveBeenCalled()
  })

  it('records a decline when notifications are still off', () => {
    const actions = { recordAccepted: vi.fn(), recordDeclined: vi.fn() }
    settlePushSettingsReturn(false, actions)
    expect(actions.recordDeclined).toHaveBeenCalledTimes(1)
    expect(actions.recordAccepted).not.toHaveBeenCalled()
  })
})

describe('startsNewAppSession', () => {
  const now = 10 * APP_SESSION_IDLE_MS

  it('keeps the session when the app was never backgrounded', () => {
    expect(startsNewAppSession(null, now)).toBe(false)
  })

  it('keeps the session after a short trip to the background', () => {
    expect(startsNewAppSession(now - APP_SESSION_IDLE_MS + 1, now)).toBe(false)
  })

  it('starts a new session after the idle threshold', () => {
    expect(startsNewAppSession(now - APP_SESSION_IDLE_MS, now)).toBe(true)
  })
})
