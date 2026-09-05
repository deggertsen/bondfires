const PRODUCTION_CONVEX_URL = 'https://ideal-akita-27.convex.cloud'
const APP_ENVIRONMENTS = ['development', 'preview', 'production']

function isCanonicalConvexUrl(value) {
  return /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(value ?? '')
}

function isValidSentryDsn(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      Boolean(parsed.username) &&
      (parsed.hostname === 'sentry.io' || parsed.hostname.endsWith('.sentry.io')) &&
      parsed.pathname !== '/'
    )
  } catch {
    return false
  }
}

/** @param {Record<string, string | undefined>} env */
function resolveAppEnvironment(env = process.env) {
  const profile = env.EAS_BUILD_PROFILE
  const profileEnvironment =
    profile === 'production'
      ? 'production'
      : profile === 'preview'
        ? 'preview'
        : profile?.startsWith('development')
          ? 'development'
          : undefined
  const requested = env.EXPO_PUBLIC_APP_ENV ?? env.APP_VARIANT ?? profileEnvironment ?? 'development'

  if (!APP_ENVIRONMENTS.includes(requested)) {
    throw new Error(
      `EXPO_PUBLIC_APP_ENV must be one of ${APP_ENVIRONMENTS.join(', ')}; received ${requested}`,
    )
  }
  if (profileEnvironment && requested !== profileEnvironment) {
    throw new Error(
      `EAS profile ${profile} must use ${profileEnvironment}, not ${requested}. Fix the profile environment variables.`,
    )
  }
  return requested
}

/**
 * @param {{ appEnvironment: string, convexUrl?: string, requireUrl?: boolean }} options
 */
function validateConvexEnvironment({ appEnvironment, convexUrl, requireUrl = true }) {
  if (!convexUrl) {
    if (requireUrl) {
      throw new Error(
        `${appEnvironment} requires EXPO_PUBLIC_CONVEX_URL. Create a separate Convex deployment and set it in the matching EAS environment.`,
      )
    }
    return
  }
  if (!isCanonicalConvexUrl(convexUrl)) {
    throw new Error('EXPO_PUBLIC_CONVEX_URL must be a canonical https://*.convex.cloud URL')
  }
  if (appEnvironment === 'production' && convexUrl !== PRODUCTION_CONVEX_URL) {
    throw new Error('Production must use the registered production Convex deployment')
  }
  if (appEnvironment !== 'production' && convexUrl === PRODUCTION_CONVEX_URL) {
    throw new Error(
      `${appEnvironment} must not use the production Convex deployment. Supply a dedicated non-production URL.`,
    )
  }
}

/**
 * @param {{ appEnvironment: string, env?: Record<string, string | undefined>, requireProduction: boolean, requireSourceMaps?: boolean }} options
 */
function validateMonitoringEnvironment({
  appEnvironment,
  env = process.env,
  requireProduction,
  requireSourceMaps = false,
}) {
  const missing = ['EXPO_PUBLIC_SENTRY_DSN', 'SENTRY_ORG', 'SENTRY_PROJECT'].filter(
    (key) => !env[key]?.trim(),
  )
  if (env.EXPO_PUBLIC_SENTRY_DSN && !isValidSentryDsn(env.EXPO_PUBLIC_SENTRY_DSN)) {
    throw new Error('EXPO_PUBLIC_SENTRY_DSN must be a valid HTTPS sentry.io project DSN')
  }
  if (missing.length > 0 && missing.length < 3) {
    throw new Error(`Monitoring configuration is incomplete: ${missing.join(', ')}`)
  }
  if (appEnvironment === 'production' && requireProduction && missing.length > 0) {
    throw new Error(`Production monitoring configuration is missing: ${missing.join(', ')}`)
  }
  if (appEnvironment === 'production' && requireSourceMaps && !env.SENTRY_AUTH_TOKEN?.trim()) {
    throw new Error('Production source-map upload requires SENTRY_AUTH_TOKEN')
  }
  if (appEnvironment === 'production' && requireProduction && env.SENTRY_NATIVE_PRIVACY_REVIEWED !== 'true') {
    throw new Error('Production requires SENTRY_NATIVE_PRIVACY_REVIEWED=true after reviewing native crash payloads and provider scrubbing')
  }
  if (appEnvironment === 'production' && requireSourceMaps &&
      [env.SENTRY_DISABLE_AUTO_UPLOAD, env.SENTRY_ALLOW_FAILURE].some((value) => value === 'true' || value === '1')) {
    throw new Error('Production must not disable source-map upload or allow upload failures')
  }
  return { enabled: missing.length === 0, missing }
}

module.exports = {
  APP_ENVIRONMENTS,
  PRODUCTION_CONVEX_URL,
  isCanonicalConvexUrl,
  isValidSentryDsn,
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
}
