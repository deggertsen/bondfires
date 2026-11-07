import { mmkvStorage, telemetry } from '@bondfires/app'
import { useMutation } from 'convex/react'
import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DeviceAgeRange } from '../../../convex/agePolicy'
import { requestDeviceAgeRange } from './deviceAgeRange'
import { type DeviceAgeRecheckRecord, shouldRecheckDeviceAge } from './deviceAgeSignal'

function readRecord(key: string): DeviceAgeRecheckRecord | null {
  const raw = mmkvStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isFinite((parsed as DeviceAgeRecheckRecord).attemptedAt) &&
      typeof (parsed as DeviceAgeRecheckRecord).answered === 'boolean'
    ) {
      return parsed as DeviceAgeRecheckRecord
    }
  } catch {
    // Corrupt record: treat as never attempted.
  }
  return null
}

/**
 * Launch / foreground device re-check for signed-in users whose age comes
 * from the device or a birth month (never for a legacy birthDate; the server
 * reports `deviceAgeRecheck` only for them). Shows no UI of its own: a phone
 * answer is sent to the server, silence keeps the last eligible band.
 */
export function useDeviceAgeRecheck({
  userId,
  checkedAt,
}: {
  userId: Id<'users'> | null
  checkedAt?: number
}) {
  const recheck = useMutation(api.registration.recheckDeviceAge)
  // Query updates must not cancel an outstanding native answer or a save retry.
  // Only changing accounts (or unmounting) ends this account's request lifecycle.
  const checkedAtRef = useRef(checkedAt)
  useEffect(() => {
    checkedAtRef.current = checkedAt
  }, [checkedAt])

  useEffect(() => {
    if (!userId) return
    const key = `device-age-recheck:${userId}`
    let cancelled = false
    let inFlight = false
    let pendingRange: DeviceAgeRange | null = null
    const run = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        // Let effect cleanup run before opening native UI (including Strict
        // Mode's setup/cleanup replay).
        await Promise.resolve()
        if (cancelled || AppState.currentState !== 'active') return
        if (!pendingRange) {
          const record = readRecord(key)
          const serverCheckedAt = checkedAtRef.current
          const latest =
            serverCheckedAt !== undefined && (!record || serverCheckedAt > record.attemptedAt)
              ? { attemptedAt: serverCheckedAt, answered: true }
              : record
          if (!shouldRecheckDeviceAge(latest)) return
          pendingRange = await requestDeviceAgeRange()
        }
        if (cancelled) return
        if (pendingRange) {
          await recheck({ expectedUserId: userId, deviceAgeRange: pendingRange })
        }
        if (cancelled) return
        // Only throttle an answer after the server saved it. A network error
        // retains that answer for the next foreground, before asking again.
        // Otherwise a later decline could erase an unsaved blocking answer.
        mmkvStorage.setItem(
          key,
          JSON.stringify({ attemptedAt: Date.now(), answered: pendingRange !== null }),
        )
        pendingRange = null
      } catch (error) {
        telemetry.warn('age:deviceRecheck', String(error))
      } finally {
        inFlight = false
      }
    }
    void run()
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void run()
    })
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [userId, recheck])
}
