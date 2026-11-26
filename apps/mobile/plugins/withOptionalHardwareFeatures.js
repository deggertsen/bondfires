const { withAndroidManifest } = require('expo/config-plugins')

// Play infers these requirements from the portrait lock and expo-network's
// ACCESS_WIFI_STATE permission. Explicit optional declarations override that filtering.
const OPTIONAL_FEATURES = ['android.hardware.screen.portrait', 'android.hardware.wifi']

module.exports = (config) =>
  withAndroidManifest(config, (result) => {
    const { manifest } = result.modResults
    const features = (manifest['uses-feature'] ??= [])
    for (const name of OPTIONAL_FEATURES) {
      const existing = features.find((feature) => feature.$?.['android:name'] === name)
      if (existing) {
        existing.$['android:required'] = 'false'
      } else {
        features.push({ $: { 'android:name': name, 'android:required': 'false' } })
      }
    }
    return result
  })
