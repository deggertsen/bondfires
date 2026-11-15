const fs = require('node:fs')
const { IOSConfig, withDangerousMod } = require('expo/config-plugins')

// Expo SDK 58 moved window creation and `factory.startReactNative(` into the
// generated SceneDelegate. @react-native-firebase/app 26.x anchors
// FirebaseApp.configure() on that call, so it silently skips the insertion and
// Firebase/Crashlytics never initialize. RNFB 27 anchors on the
// `return super.application(...)` line instead, but 27 is SPM-only and we build
// with `disableSPM`. Backport that anchor until the RNFB 27 move.
const CONFIGURE = 'FirebaseApp.configure()'
const IMPORT = 'import FirebaseCore'
const SUPER_RETURN =
  /^([ \t]*)return\s+super\.application\(\s*application\s*,\s*didFinishLaunchingWithOptions:\s*launchOptions\s*\)/m

/** Insert FirebaseApp.configure() (and its import) into the SDK 58 AppDelegate. */
function addFirebaseConfigure(contents) {
  let updated = contents
  if (!/^[ \t]*import\s+FirebaseCore[ \t]*$/m.test(updated)) {
    updated = updated.replace(/^([ \t]*import\s+[^\r\n]*\n)/m, `$1${IMPORT}\n`)
  }
  if (updated.includes(CONFIGURE)) return updated
  if (!SUPER_RETURN.test(updated)) {
    throw new Error(
      'withFirebaseSceneAppDelegate: could not find `return super.application(...)` in AppDelegate.swift. Update the plugin before building.',
    )
  }
  return updated.replace(SUPER_RETURN, (line, indent) => `${indent}${CONFIGURE}\n${line}`)
}

module.exports = (config) =>
  withDangerousMod(config, [
    'ios',
    async (result) => {
      const { path } = IOSConfig.Paths.getAppDelegate(result.modRequest.projectRoot)
      const contents = await fs.promises.readFile(path, 'utf8')
      await fs.promises.writeFile(path, addFirebaseConfigure(contents))
      return result
    },
  ])
module.exports.addFirebaseConfigure = addFirebaseConfigure
