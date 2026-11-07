import { mmkvStorage, telemetry } from '@bondfires/app'
import { useMutation } from 'convex/react'
import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
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

  useEffect(() => {
    if (!userId) return
    const key = `device-age-recheck:${userId}`
    let cancelled = false
    let inFlight = false
    const run = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        // Let effect cleanup run before opening native UI (including Strict
        // Mode's setup/cleanup replay).
        await Promise.resolve()
        if (cancelled) return
        const record = readRecord(key)
        const latest =
          checkedAt !== undefined && (!record || checkedAt > record.attemptedAt)
            ? { attemptedAt: checkedAt, answered: true }
            : record
        if (!shouldRecheckDeviceAge(latest)) return
        const range = await requestDeviceAgeRange()
        if (cancelled) return
        if (range) await recheck({ expectedUserId: userId, deviceAgeRange: range })
        // Only throttle an answer after the server saved it. A network error
        // must leave the next foreground free to retry.
        mmkvStorage.setItem(
          key,
          JSON.stringify({ attemptedAt: Date.now(), answered: range !== null }),
        )
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
  }, [userId, checkedAt, recheck])
}
