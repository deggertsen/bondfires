import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { addPodsDeploymentTarget } = require('../apps/mobile/plugins/withPodsDeploymentTarget.js')
const { setJvmArgs, JVM_ARGS } = require('../apps/mobile/plugins/withGradleJvmArgs.js')
const {
  adoptSceneLifecycle,
  WINDOW_BLOCK,
} = require('../apps/mobile/plugins/withIosSceneLifecycle.js')

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

const appDelegateTemplate = `public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

${WINDOW_BLOCK}

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

  it('moves React Native startup out of didFinishLaunching for the iOS 27 scene lifecycle', () => {
    const updated = adoptSceneLifecycle(appDelegateTemplate)
    expect(updated).toContain('var launchOptions: [UIApplication.LaunchOptionsKey: Any]?')
    expect(updated).toContain('self.launchOptions = launchOptions')
    expect(updated).not.toContain('UIWindow(frame: UIScreen.main.bounds)')
    expect(updated).not.toContain('factory.startReactNative')
    expect(adoptSceneLifecycle(updated)).toBe(updated)
  })

  it('keeps FirebaseApp.configure when it was inserted inside the startup block', () => {
    const withFirebase = appDelegateTemplate.replace(
      '    window = UIWindow(frame: UIScreen.main.bounds)\n',
      '    window = UIWindow(frame: UIScreen.main.bounds)\nFirebaseApp.configure()\n',
    )
    const updated = adoptSceneLifecycle(withFirebase)
    expect(updated).toContain('FirebaseApp.configure()')
    expect(updated).toContain('self.launchOptions = launchOptions')
    expect(updated).not.toContain('factory.startReactNative')
    expect(updated.indexOf('FirebaseApp.configure()')).toBeLessThan(
      updated.indexOf('self.launchOptions = launchOptions'),
    )
  })

  it('fails visibly when the Expo AppDelegate startup block changes', () => {
    expect(() => adoptSceneLifecycle('class AppDelegate {}\n')).toThrow(
      'no longer matches the Expo startup block',
    )
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
})
