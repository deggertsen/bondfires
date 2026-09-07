import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { scrubMonitoringError } from './monitoringPrivacy'

type CrashlyticsSdk = typeof import('@react-native-firebase/crashlytics')
type GlobalErrorHandler = (error: Error, fatal?: boolean) => void
type ErrorUtilsApi = {
  getGlobalHandler: () => GlobalErrorHandler
  setGlobalHandler: (handler: GlobalErrorHandler) => void
}

export function getMonitoringConfig() {
  const extra = Constants.expoConfig?.extra
  const environment = extra?.appEnvironment ?? 'development'
  return {
    enabled:
      extra?.monitoringEnabled === true &&
      environment !== 'development' &&
      Platform.OS !== 'web' &&
      Constants.appOwnership !== 'expo',
    environment,
    release: `org.bondfires@${Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '0.0.0'}`,
    dist: Constants.nativeBuildVersion ?? String(Constants.expoConfig?.ios?.buildNumber ?? '0'),
  }
}

let sdk: CrashlyticsSdk | undefined
let instance: ReturnType<CrashlyticsSdk['getCrashlytics']> | undefined
let initialization: Promise<boolean> | undefined

export function initializeMonitoring(): Promise<boolean> {
  if (initialization) return initialization
  const config = getMonitoringConfig()
  if (!config.enabled) return Promise.resolve(false)
  initialization = (async () => {
    try {
      // Lazy-load so Expo Go, web and unconfigured development can still launch.
      sdk = await import('@react-native-firebase/crashlytics')
      // @ts-expect-error This SDK-owned polyfill exposes no module declarations.
      const rejectionTracking = (await import('promise/setimmediate/rejection-tracking')).default
      const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsApi }).ErrorUtils
      const originalHandler = errorUtils?.getGlobalHandler()
      instance = sdk.getCrashlytics()
      // RNFB installs unfiltered JS handlers on first access. Replace them with
      // our scrubbed reporters, preserving RN/Convex handling of the original error.
      if (errorUtils && originalHandler) {
        errorUtils.setGlobalHandler((error, fatal) => {
          captureUnhandledException(error)
          originalHandler(error, fatal)
        })
      }
      rejectionTracking.enable({
        allRejections: true,
        onUnhandled: (_id: number, error: unknown) => captureUnhandledException(error),
        onHandled: () => {},
      })
      await sdk.setAttributes(instance, {
        environment: config.environment,
        release: config.release,
        dist: config.dist,
      })
      await sdk.setCrashlyticsCollectionEnabled(instance, true)
      return true
    } catch {
      // Monitoring must not create a startup crash or recursively report itself.
      console.warn('Crashlytics initialization failed; verify the native build configuration.')
      return false
    }
  })()
  return initialization
}

export function captureUnhandledException(error: unknown): void {
  if (!sdk || !instance) return
  try {
    sdk.recordError(instance, scrubMonitoringError(error))
  } catch {
    // Best effort; preserve the app's existing error/fallback behavior.
  }
}

void initializeMonitoring()
