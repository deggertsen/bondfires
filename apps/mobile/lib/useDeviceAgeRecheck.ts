import { mmkvStorage, telemetry } from '@bondfires/app'
import { useMutation } from 'convex/react'
import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { api } from '../../../convex/_generated/api'
import { requestDeviceAgeRange } from './deviceAgeRange'
import { type DeviceAgeRecheckRecord, shouldRecheckDeviceAge } from './deviceAgeSignal'

const RECHECK_KEY = 'device-age-recheck'

function readRecord(): DeviceAgeRecheckRecord | null {
  const raw = mmkvStorage.getItem(RECHECK_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as DeviceAgeRecheckRecord).attemptedAt === 'number' &&
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
export function useDeviceAgeRecheck({ enabled }: { enabled: boolean }) {
  const recheck = useMutation(api.registration.recheckDeviceAge)
  const recheckRef = useRef(recheck)
  recheckRef.current = recheck
  const inFlight = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const run = async () => {
      if (inFlight.current || !shouldRecheckDeviceAge(readRecord())) return
      inFlight.current = true
      try {
        const range = await requestDeviceAgeRange()
        mmkvStorage.setItem(
          RECHECK_KEY,
          JSON.stringify({ attemptedAt: Date.now(), answered: range !== null }),
        )
        if (range) await recheckRef.current({ deviceAgeRange: range })
      } catch (error) {
        telemetry.warn('age:deviceRecheck', String(error))
      } finally {
        inFlight.current = false
      }
    }
    void run()
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void run()
    })
    return () => subscription.remove()
  }, [enabled])
}
