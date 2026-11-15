import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { addPodsDeploymentTarget } = require('../apps/mobile/plugins/withPodsDeploymentTarget.js')
const { setJvmArgs, JVM_ARGS } = require('../apps/mobile/plugins/withGradleJvmArgs.js')
const { addFirebaseConfigure } = require('../apps/mobile/plugins/withFirebaseSceneAppDelegate.js')

// Match the multiline call emitted by the installed Expo template, including
// code after the hook so insertion cannot silently move outside post_install.
const podfile = `target 'Bondfires' do
  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
    keep_existing_post_install_work(installer)
  end
end
`

// Expo SDK 58 AppDelegate: React Native starts in SceneDelegate, so the only
// stable anchor left in didFinishLaunching is the super call.
const sceneAppDelegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    reactNativeFactory = factory

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`

describe('native build config plugins', () => {
  it('inserts the pod floor after React Native setup and preserves the remaining hook', () => {
    const updated = addPodsDeploymentTarget(podfile)
    expect(updated.indexOf('bondfires_min_ios =')).toBeGreaterThan(
      updated.indexOf(':ccache_enabled =>'),
    )
    expect(updated).toContain("podfile_properties.fetch('ios.deploymentTarget')")
    expect(updated).toContain('Gem::Version.new(current) < Gem::Version.new(bondfires_min_ios)')
    expect(updated).toMatch(
      /\n {4}end\n {4}keep_existing_post_install_work\(installer\)\n {2}end\nend\n$/,
    )
    expect(addPodsDeploymentTarget(updated)).toBe(updated)
  })

  it('fails visibly when the upstream Podfile hook changes', () => {
    expect(() => addPodsDeploymentTarget("target 'Bondfires' do\nend\n")).toThrow(
      'could not find react_native_post_install',
    )
  })

  it('replaces duplicate JVM properties without changing unrelated Gradle properties', () => {
    const unrelated = { type: 'property', key: 'android.useAndroidX', value: 'true' }
    const comment = { type: 'comment', value: 'Keep this comment' }
    const updated = setJvmArgs([
      comment,
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m' },
      unrelated,
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx1024m' },
    ])
    expect(updated).toEqual([
      comment,
      unrelated,
      { type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS },
    ])
    expect(setJvmArgs(updated)).toEqual(updated)
  })

  it('adds the memory budget when the template omits JVM properties', () => {
    expect(setJvmArgs([])).toEqual([
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
      },
    ])
  })

  it('configures Firebase before the AppDelegate super call on the SDK 58 template', () => {
    const updated = addFirebaseConfigure(sceneAppDelegate)
    expect(updated).toContain('import FirebaseCore')
    expect(updated).toContain(
      '    FirebaseApp.configure()\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    )
    expect(addFirebaseConfigure(updated)).toBe(updated)
  })

  it('leaves an AppDelegate that already configures Firebase alone', () => {
    const configured = sceneAppDelegate.replace(
      '    return super.application',
      '    FirebaseApp.configure()\n    return super.application',
    )
    expect(addFirebaseConfigure(configured).match(/FirebaseApp\.configure\(\)/g)).toHaveLength(1)
  })

  it('fails visibly when the AppDelegate super call changes', () => {
    expect(() => addFirebaseConfigure('import UIKit\nclass AppDelegate {}\n')).toThrow(
      'could not find `return super.application(...)`',
    )
  })
})
