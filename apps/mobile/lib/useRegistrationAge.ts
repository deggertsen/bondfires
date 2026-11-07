import { useEffect, useRef, useState } from 'react'
import type { DeviceAgeRange } from '../../../convex/agePolicy'
import { requestDeviceAgeRange } from './deviceAgeRange'
import { decideRegistrationAgeStep, type RegistrationAgeStep } from './deviceAgeSignal'

/** One request per registration form, with a fresh subscriber after effect replay. */
export function useRegistrationAge(enabled: boolean) {
  const request = useRef<Promise<DeviceAgeRange | null> | null>(null)
  const [age, setAge] = useState<{
    step: 'checking' | RegistrationAgeStep
    range: DeviceAgeRange | null
  }>({ step: 'checking', range: null })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    request.current ??= requestDeviceAgeRange()
    void request.current.then((range) => {
      if (!cancelled) setAge({ step: decideRegistrationAgeStep(range), range })
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return age
}
