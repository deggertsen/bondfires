const {
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
} = require('./config/environment.cjs')
const { validateFirebaseFiles } = require('./config/firebase.cjs')

module.exports = ({ config: baseConfig }) => {
  const appEnvironment = resolveAppEnvironment(process.env)
  const isEasBuild = Boolean(process.env.EAS_BUILD_PROFILE)
  validateConvexEnvironment({
    appEnvironment,
    convexUrl: process.env.EXPO_PUBLIC_CONVEX_URL,
    requireUrl: isEasBuild,
  })
  const monitoring = validateMonitoringEnvironment({
    appEnvironment,
    env: process.env,
    requireProduction: isEasBuild,
  })
  if (monitoring.enabled) validateFirebaseFiles({ mobileRoot: __dirname, config: baseConfig })

  return {
    ...baseConfig,
    extra: {
      ...baseConfig.extra,
      appEnvironment,
      monitoringEnabled: monitoring.enabled,
    },
  }
}
