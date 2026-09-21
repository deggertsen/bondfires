import { mmkvStorage } from '@bondfires/app'
import type { useAuthActions } from '@convex-dev/auth/react'

export const AUTH_CALLBACK = 'bondfires://auth-callback'
const PENDING_KEY = 'social-auth-pending'
const DESTINATION_KEY = 'registration-destination'
type SignIn = ReturnType<typeof useAuthActions>['signIn']
let exchange: { code: string; promise: Promise<string | undefined> } | undefined

export function rememberSocialSignIn(provider: 'apple' | 'google', redirectTo?: string) {
  exchange = undefined
  mmkvStorage.setItem(PENDING_KEY, JSON.stringify({ provider, startedAt: Date.now(), redirectTo }))
}
export function cancelSocialSignIn() {
  mmkvStorage.removeItem(PENDING_KEY)
}
export function registrationDestination() {
  return mmkvStorage.getItem(DESTINATION_KEY) ?? undefined
}
export function clearRegistrationDestination() {
  mmkvStorage.removeItem(DESTINATION_KEY)
}

// Both Expo Router and the browser session may receive the same redirect on
// Android. Exchange exactly once, including when the app resumes from a cold start.
export function finishSocialSignIn(code: string, signIn: SignIn): Promise<string | undefined> {
  if (exchange?.code === code) return exchange.promise
  const promise = (async () => {
    const raw = mmkvStorage.getItem(PENDING_KEY)
    if (!raw || !code) throw new Error('Sign-in expired. Please try again.')
    const pending = JSON.parse(raw) as { provider: string; startedAt: number; redirectTo?: string }
    if (
      !['apple', 'google'].includes(pending.provider) ||
      Date.now() - pending.startedAt > 15 * 60_000
    ) {
      cancelSocialSignIn()
      throw new Error('Sign-in expired. Please try again.')
    }
    const result = await signIn(pending.provider, { code })
    if (!result.signingIn) throw new Error('Unable to finish sign-in. Please try again.')
    if (pending.redirectTo) mmkvStorage.setItem(DESTINATION_KEY, pending.redirectTo)
    else clearRegistrationDestination()
    cancelSocialSignIn()
    return pending.redirectTo
  })()
  exchange = { code, promise }
  return promise
}
