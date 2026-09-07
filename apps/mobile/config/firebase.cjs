const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

// Validate public app registrations, never the Play submission service-account key.
function validateFirebaseFiles({ mobileRoot, config }) {
  const read = (path) => {
    if (!path) throw new Error('Firebase googleServicesFile is required for both platforms')
    return readFileSync(resolve(mobileRoot, path), 'utf8')
  }
  const android = JSON.parse(read(config.android?.googleServicesFile))
  const ios = read(config.ios?.googleServicesFile)
  const field = (key) => ios.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]
  if (!android.client?.some((client) =>
    client.client_info?.android_client_info?.package_name === config.android?.package &&
    client.client_info?.mobilesdk_app_id,
  )) throw new Error('Firebase Android registration does not match the app package')
  if (field('BUNDLE_ID') !== config.ios?.bundleIdentifier || !field('GOOGLE_APP_ID')) {
    throw new Error('Firebase iOS registration does not match the app bundle identifier')
  }
  if (!field('PROJECT_ID') || field('PROJECT_ID') !== android.project_info?.project_id) {
    throw new Error('Firebase iOS and Android must use the same project')
  }
}
module.exports = { validateFirebaseFiles }
