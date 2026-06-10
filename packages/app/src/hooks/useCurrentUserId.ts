import { useValue } from '@legendapp/state/react'
import { useQuery } from 'convex/react'
import { useEffect, useRef } from 'react'
import { api } from '../../../../convex/_generated/api'
import { telemetry } from '../services/telemetry'
import { appActions, appStore$ } from '../store/app.store'

/**
 * Returns the authenticated user's Convex ID and keeps `appStore$.userId` in sync.
 *
 * Prefer this over reading `appStore$.userId` directly for ownership checks.
 * The persisted Legend State value can lag behind Convex auth after restore,
 * hot reload, or when `users.current` resolves before `index.tsx` runs `setAuth`.
 */
export function useCurrentUserId() {
  const currentUser = useQuery(api.users.current)
  const storeUserId = useValue(appStore$.userId)
  const mismatchLoggedRef = useRef(false)

  useEffect(() => {
    if (currentUser === undefined) {
      return
    }

    const convexUserId = currentUser?._id ?? null
    if (convexUserId === storeUserId) {
      mismatchLoggedRef.current = false
      return
    }

    if (!mismatchLoggedRef.current) {
      mismatchLoggedRef.current = true
      telemetry.warn('auth:userId-mismatch', 'Convex user ID differs from app store', {
        convexUserId,
        storeUserId,
        source: 'useCurrentUserId',
      })
    }

    if (convexUserId) {
      appActions.setAuth(convexUserId)
    } else {
      appActions.logout()
    }
  }, [currentUser, storeUserId])

  return {
    userId: currentUser === undefined ? null : (currentUser?._id ?? null),
    isLoading: currentUser === undefined,
    currentUser,
  }
}
