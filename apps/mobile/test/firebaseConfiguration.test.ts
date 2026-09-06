import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateFirebaseFiles } from '../config/firebase.cjs'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture({
  androidPackage = 'org.bondfires',
  iosBundle = 'org.bondfires',
  iosProject = 'example',
} = {}) {
  const mobileRoot = mkdtempSync(join(tmpdir(), 'bondfires-firebase-test-'))
  directories.push(mobileRoot)
  writeFileSync(
    join(mobileRoot, 'android.json'),
    JSON.stringify({
      project_info: { project_id: 'example' },
      client: [
        {
          client_info: {
            mobilesdk_app_id: 'test-app',
            android_client_info: { package_name: androidPackage },
          },
        },
      ],
    }),
  )
  writeFileSync(
    join(mobileRoot, 'ios.plist'),
    `<plist><dict><key>PROJECT_ID</key><string>${iosProject}</string><key>BUNDLE_ID</key><string>${iosBundle}</string><key>GOOGLE_APP_ID</key><string>test-app</string></dict></plist>`,
  )
  return {
    mobileRoot,
    config: {
      ios: { bundleIdentifier: 'org.bondfires', googleServicesFile: './ios.plist' },
      android: { package: 'org.bondfires', googleServicesFile: './android.json' },
    },
  }
}
describe('Firebase registration preflight', () => {
  it('accepts matching public registrations', () => {
    expect(() => validateFirebaseFiles(fixture())).not.toThrow()
  })
  it.each([
    { androidPackage: 'wrong' },
    { iosBundle: 'wrong' },
    { iosProject: 'different-project' },
  ])('rejects cross-app/project configuration %j', (options) => {
    expect(() => validateFirebaseFiles(fixture(options))).toThrow(/Firebase/)
  })
  it('requires configuration files', () => {
    const input = fixture()
    input.config.ios.googleServicesFile = ''
    expect(() => validateFirebaseFiles(input)).toThrow(/googleServicesFile/)
  })
})
