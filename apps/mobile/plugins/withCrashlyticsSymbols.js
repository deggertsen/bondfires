const { withAppBuildGradle } = require('expo/config-plugins')

// RNFB installs the plugin/NDK SDK; explicitly enable and run release symbol upload.
module.exports = (config) => withAppBuildGradle(config, (result) => {
  const marker = '// Bondfires Crashlytics native symbols'
  if (!result.modResults.contents.includes(marker)) {
    result.modResults.contents += `
${marker}
plugins.withId('com.google.firebase.crashlytics') {
    android.buildTypes.release.firebaseCrashlytics {
        nativeSymbolUploadEnabled true
    }
    tasks.configureEach { task ->
        if (task.name == 'assembleRelease' || task.name == 'bundleRelease') {
            task.finalizedBy('uploadCrashlyticsSymbolFileRelease')
        }
    }
}
`
  }
  return result
})
