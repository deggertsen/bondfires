const { withPodfile } = require('expo/config-plugins')

// Xcode 27 rejects iOS deployment targets below 15.0. Several pods (and their
// privacy resource bundles: nanopb, PromisesObjC/Swift, GoogleDataTransport,
// GoogleUtilities, SDWebImage, RNSVG) still declare 9.0–12.4, which fails the
// archive. Raise every pod target to at least the app's own minimum.
const MARKER = '# Bondfires: raise pod deployment targets to the app minimum'

const SNIPPET = `
    ${MARKER} (Xcode 27 rejects < 15.0).
    bondfires_min_ios = podfile_properties['ios.deploymentTarget'] || '16.4'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < Gem::Version.new(bondfires_min_ios)
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = bondfires_min_ios
        end
      end
    end`

/** Insert the snippet after react_native_post_install(...) inside post_install. */
function addPodsDeploymentTarget(contents) {
  if (contents.includes(MARKER)) return contents
  const pattern = /(post_install do \|installer\|[\s\S]*?react_native_post_install\([\s\S]*?\n\s*\))/
  if (!pattern.test(contents)) {
    throw new Error('withPodsDeploymentTarget: could not find react_native_post_install in Podfile')
  }
  return contents.replace(pattern, `$1\n${SNIPPET}`)
}

module.exports = (config) =>
  withPodfile(config, (result) => {
    result.modResults.contents = addPodsDeploymentTarget(result.modResults.contents)
    return result
  })
module.exports.addPodsDeploymentTarget = addPodsDeploymentTarget
