import * as Sentry from '@sentry/react-native'
import Constants from 'expo-constants'
import type { ComponentType } from 'react'
import { scrubSentryBreadcrumb, scrubSentryEvent } from './monitoringPrivacy'

export type MonitoringConfig = {
  enabled: boolean
  dsn?: string
  environment: 'development' | 'preview' | 'production'
  release: string
  dist: string
}

export function getMonitoringConfig(
  env: Record<string, string | undefined> = {
    // Expo only inlines EXPO_PUBLIC_* values when accessed with direct dot notation.
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  },
): MonitoringConfig {
  const configuredEnvironment = Constants.expoConfig?.extra?.appEnvironment
  const environment =
    configuredEnvironment === 'preview' || configuredEnvironment === 'production'
      ? configuredEnvironment
      : 'development'
  const version = Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '0.0.0'
  const dist =
    Constants.nativeBuildVersion ??
    String(
      Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '0',
    )
  const dsn = env.EXPO_PUBLIC_SENTRY_DSN?.trim()
  return {
    enabled: Boolean(dsn),
    dsn: dsn || undefined,
    environment,
    release: `org.bondfires@${version}`,
    dist,
  }
}

const monitoringConfig = getMonitoringConfig()
let initialized = false

export function initializeMonitoring(): boolean {
  if (initialized || !monitoringConfig.enabled) return initialized
  Sentry.init({
    dsn: monitoringConfig.dsn,
    enabled: true,
    environment: monitoringConfig.environment,
    release: monitoringConfig.release,
    dist: monitoringConfig.dist,
    sendDefaultPii: false,
    sampleRate: 1,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableNative: true,
    enableNativeCrashHandling: true,
    enableNdk: true,
    enableAutoSessionTracking: true,
    enableWatchdogTerminationTracking: true,
    enableAppHangTracking: true,
    beforeSend: (event) => scrubSentryEvent(event) as unknown as typeof event,
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb) as typeof breadcrumb,
  })
  initialized = true
  return true
}

export function captureUnhandledException(error: unknown): void {
  if (!initialized) return
  Sentry.captureException(error)
}

export function wrapWithMonitoring<P extends Record<string, unknown>>(
  component: ComponentType<P>,
): ComponentType<P> {
  return initialized ? Sentry.wrap(component) : component
}

initializeMonitoring()
