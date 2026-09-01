const {
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
} = require('./config/environment.cjs')

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
    requireSourceMaps: isEasBuild,
  })

  const plugins = [...(baseConfig.plugins ?? [])]
  if (monitoring.enabled) {
    plugins.push([
      '@sentry/react-native/expo',
      {
        url: 'https://sentry.io/',
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
      },
    ])
  }

  return {
    ...baseConfig,
    plugins,
    extra: {
      ...baseConfig.extra,
      appEnvironment,
      monitoringEnabled: monitoring.enabled,
    },
  }
}
