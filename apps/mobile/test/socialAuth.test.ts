import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storage } = vi.hoisted(() => ({ storage: new Map<string, string>() }))
vi.mock('@bondfires/app', () => ({
  mmkvStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
}))

import {
  cancelSocialSignIn,
  finishSocialSignIn,
  registrationDestination,
  rememberSocialSignIn,
} from '../lib/socialAuth'

beforeEach(() => {
  storage.clear()
  rememberSocialSignIn('google')
  cancelSocialSignIn()
})
describe('social sign-in callback', () => {
  it('exchanges a duplicate browser/router callback only once and retains the invitation', async () => {
    rememberSocialSignIn('google', '/invite/test')
    const signIn = vi.fn().mockResolvedValue({ signingIn: true })
    const [first, second] = await Promise.all([
      finishSocialSignIn('one-time-code', signIn),
      finishSocialSignIn('one-time-code', signIn),
    ])
    expect(first).toBe('/invite/test')
    expect(second).toBe(first)
    expect(signIn).toHaveBeenCalledExactlyOnceWith('google', { code: 'one-time-code' })
    expect(registrationDestination()).toBe('/invite/test')
  })
  it('requires a locally initiated sign-in and rejects expired or cancelled flows', async () => {
    const signIn = vi.fn()
    await expect(finishSocialSignIn('unsolicited', signIn)).rejects.toThrow('expired')
    rememberSocialSignIn('apple')
    cancelSocialSignIn()
    await expect(finishSocialSignIn('cancelled', signIn)).rejects.toThrow('expired')
    storage.set(
      'social-auth-pending',
      JSON.stringify({ provider: 'apple', startedAt: Date.now() - 16 * 60_000 }),
    )
    await expect(finishSocialSignIn('expired', signIn)).rejects.toThrow('expired')
    expect(signIn).not.toHaveBeenCalled()
  })
  it('does not treat a failed exchange as successful authentication', async () => {
    rememberSocialSignIn('apple')
    await expect(
      finishSocialSignIn('failed', vi.fn().mockResolvedValue({ signingIn: false })),
    ).rejects.toThrow('Unable')
    expect(registrationDestination()).toBeUndefined()
  })
})
