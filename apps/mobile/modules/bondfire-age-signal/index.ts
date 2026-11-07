import { requireNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'
import type { DeviceAgeSignalResult } from '../../lib/deviceAgeSignal'

/**
 * Local Expo module: Apple Declared Age Range (iOS 26+) and Google Play Age
 * Signals (Android). Both are client-reported OS signals, not identity
 * verification. Every failure path resolves to `{ status: 'unavailable' }`.
 */
type BondfireAgeSignalNativeModule = {
  requestAgeRange(minimumGate: number, adultGate: number): Promise<DeviceAgeSignalResult>
}

const UNAVAILABLE: DeviceAgeSignalResult = { status: 'unavailable' }
const MINIMUM_IOS_MAJOR_VERSION = 26

function iosMajorVersion(): number | null {
  const major = Number.parseInt(String(Platform.Version).split('.')[0] ?? '', 10)
  return Number.isFinite(major) ? major : null
}

/** iOS before 26 has no Declared Age Range; the app keeps its 16.4 deployment target. */
export function isDeviceAgeSignalSupported(): boolean {
  if (Platform.OS === 'ios') {
    const major = iosMajorVersion()
    return major !== null && major >= MINIMUM_IOS_MAJOR_VERSION
  }
  return Platform.OS === 'android'
}

function loadNativeModule(): BondfireAgeSignalNativeModule | null {
  try {
    return requireNativeModule<BondfireAgeSignalNativeModule>('BondfireAgeSignal')
  } catch {
    // Expo Go / a build without the module: behave as if the phone cannot answer.
    return null
  }
}

export async function requestNativeAgeRange(
  minimumGate: number,
  adultGate: number,
): Promise<DeviceAgeSignalResult> {
  if (!isDeviceAgeSignalSupported()) return UNAVAILABLE
  const native = loadNativeModule()
  if (!native) return UNAVAILABLE
  try {
    const result = await native.requestAgeRange(minimumGate, adultGate)
    if (result?.status === 'shared' || result?.status === 'declined') return result
    return UNAVAILABLE
  } catch {
    return UNAVAILABLE
  }
}
