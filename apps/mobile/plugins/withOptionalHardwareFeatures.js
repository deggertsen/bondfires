const { withAndroidManifest } = require('expo/config-plugins')

// Play Console treats these as required hardware and blocks review / device
// availability until they are explicitly optional:
// - android:screenOrientation="portrait" implies android.hardware.screen.portrait
// - ACCESS_WIFI_STATE from expo-network implies android.hardware.wifi
// required="false" keeps portrait lock and wifi-state reads, but lets phones,
// tablets, desktop, and Android XR install when they don't report the feature.
const OPTIONAL_FEATURES = ['android.hardware.screen.portrait', 'android.hardware.wifi']

function asFeatureArray(usesFeature) {
  if (!usesFeature) return []
  return Array.isArray(usesFeature) ? usesFeature : [usesFeature]
}

function markFeaturesOptional(manifest) {
  const usesFeature = asFeatureArray(manifest['uses-feature'])
  for (const name of OPTIONAL_FEATURES) {
    const existing = usesFeature.find((feature) => feature.$?.['android:name'] === name)
    if (existing) {
      existing.$['android:required'] = 'false'
    } else {
      usesFeature.push({
        $: {
          'android:name': name,
          'android:required': 'false',
        },
      })
    }
  }
  manifest['uses-feature'] = usesFeature
  return manifest
}

module.exports = (config) =>
  withAndroidManifest(config, (result) => {
    markFeaturesOptional(result.modResults.manifest)
    return result
  })

module.exports.markFeaturesOptional = markFeaturesOptional
module.exports.OPTIONAL_FEATURES = OPTIONAL_FEATURES
