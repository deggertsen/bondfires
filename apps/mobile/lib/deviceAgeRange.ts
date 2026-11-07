import { Platform } from 'react-native'
import type { DeviceAgeRange } from '../../../convex/agePolicy'
import { requestNativeAgeRange } from '../modules/bondfire-age-signal'
import {
  DEVICE_AGE_GATES,
  deviceAgeSourceForPlatform,
  resolveDeviceAgeRange,
} from './deviceAgeSignal'

/**
 * Ask this phone for its age range (Apple Declared Age Range on iOS 26+, Play
 * Age Signals on Android). Resolves to null whenever the phone gives nothing:
 * declined, unsupported OS, missing module, Play Services error, or any throw.
 * This is a client-reported signal, not identity verification.
 */
export function requestDeviceAgeRange(): Promise<DeviceAgeRange | null> {
  return resolveDeviceAgeRange(
    () => requestNativeAgeRange(DEVICE_AGE_GATES.minimum, DEVICE_AGE_GATES.adult),
    deviceAgeSourceForPlatform(Platform.OS),
  )
}
