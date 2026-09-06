const PRODUCTION_CONVEX_URL = 'https://ideal-akita-27.convex.cloud'
const APP_ENVIRONMENTS = ['development', 'preview', 'production']

function isCanonicalConvexUrl(value) {
  return /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(value ?? '')
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
 * @param {{ appEnvironment: string, env?: Record<string, string | undefined>, requireProduction: boolean }} options
 */
function validateMonitoringEnvironment({
  appEnvironment,
  env = process.env,
  requireProduction,
}) {
  const value = env.CRASHLYTICS_ENABLED
  if (value && value !== 'true' && value !== 'false') {
    throw new Error('CRASHLYTICS_ENABLED must be true or false')
  }
  const enabled = value === 'true' && appEnvironment !== 'development'
  if (appEnvironment === 'production' && requireProduction && !enabled) {
    throw new Error('Production monitoring requires CRASHLYTICS_ENABLED=true')
  }
  if (appEnvironment === 'production' && enabled && env.MONITORING_NATIVE_PRIVACY_REVIEWED !== 'true') {
    throw new Error('Production requires MONITORING_NATIVE_PRIVACY_REVIEWED=true after reviewing Crashlytics native payloads and privacy declarations')
  }
  return { enabled }
}

module.exports = {
  APP_ENVIRONMENTS,
  PRODUCTION_CONVEX_URL,
  isCanonicalConvexUrl,
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
}
