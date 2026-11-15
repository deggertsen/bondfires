const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withFinalizedMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins')

const MARKER = 'self.launchOptions = launchOptions'

const WINDOW_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`

const LAUNCH_OPTIONS_PROPERTY = `  var reactNativeFactory: RCTReactNativeFactory?
  /// Cold-start options. SceneDelegate merges URL contexts and starts React Native.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?`

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ],
  },
}

const SCENE_DELEGATE = `import UIKit

/// The iOS 27 SDK traps apps that still own the window from the app delegate.
/// UIKit also stops delivering URL, user-activity, and foreground callbacks to
/// the app delegate once a scene manifest is present, so those are forwarded.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      fatalError("SceneDelegate could not start React Native. AppDelegate.reactNativeFactory was nil.")
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions(appDelegate.launchOptions, connectionOptions)
    )

    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: context.url,
        options: openURLOptions(context.options)
      )
    }
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity) { _ in }
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    forward { $0.applicationDidBecomeActive(UIApplication.shared) }
  }

  func sceneWillResignActive(_ scene: UIScene) {
    forward { $0.applicationWillResignActive(UIApplication.shared) }
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    forward { $0.applicationWillEnterForeground(UIApplication.shared) }
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    forward { $0.applicationDidEnterBackground(UIApplication.shared) }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: context.url,
        options: openURLOptions(context.options)
      )
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity) { _ in }
  }

  private func forward(_ call: (AppDelegate) -> Void) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    call(appDelegate)
  }
}

private func launchOptions(
  _ existing: [UIApplication.LaunchOptionsKey: Any]?,
  _ connectionOptions: UIScene.ConnectionOptions
) -> [UIApplication.LaunchOptionsKey: Any]? {
  var options = existing ?? [:]
  let urlKey = UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")
  if options[urlKey] == nil, let url = connectionOptions.urlContexts.first?.url {
    options[urlKey] = url
  }
  let activityKey = UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")
  if options[activityKey] == nil,
    let activity = connectionOptions.userActivities.first(where: {
      $0.activityType == NSUserActivityTypeBrowsingWeb
    })
  {
    options[activityKey] = [
      "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
      "UIApplicationLaunchOptionsUserActivityKey": activity,
    ]
  }
  return options.isEmpty ? nil : options
}

private func openURLOptions(_ sceneOptions: UIScene.OpenURLOptions) -> [UIApplication.OpenURLOptionsKey: Any] {
  var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  if let sourceApplication = sceneOptions.sourceApplication {
    options[.sourceApplication] = sourceApplication
  }
  if let annotation = sceneOptions.annotation {
    options[.annotation] = annotation
  }
  options[.openInPlace] = sceneOptions.openInPlace
  return options
}
`

/**
 * Move React Native startup out of didFinishLaunching. The iOS 27 SDK crashes
 * at launch unless a scene delegate owns the window.
 */
const STARTUP_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n    window = UIWindow\(frame: UIScreen\.main\.bounds\)\n([\s\S]*?)    factory\.startReactNative\(\n      withModuleName: "main",\n      in: window,\n      launchOptions: launchOptions\)\n#endif/

function adoptSceneLifecycle(contents) {
  if (contents.includes(MARKER) && !contents.includes('UIWindow(frame: UIScreen.main.bounds)')) {
    return contents
  }
  const match = contents.match(STARTUP_BLOCK)
  if (!match) {
    throw new Error(
      'withIosSceneLifecycle: AppDelegate.swift no longer matches the Expo startup block. Update the plugin before building.',
    )
  }
  const between = match[1]
  const residue = between
    .replace(
      /\/\/ @generated begin @react-native-firebase\/app-didFinishLaunchingWithOptions[\s\S]*?\/\/ @generated end @react-native-firebase\/app-didFinishLaunchingWithOptions\n?/,
      '',
    )
    .replace(/FirebaseApp\.configure\(\)\n?/,
      '')
    .trim()
  if (residue) {
    throw new Error(
      `withIosSceneLifecycle: unexpected code between window creation and startReactNative: ${residue}`,
    )
  }
  const kept = between.includes('FirebaseApp.configure()') ? '    FirebaseApp.configure()\n' : ''
  let updated = contents.replace(STARTUP_BLOCK, `${kept}    ${MARKER}`)
  const propertyAnchor = '  var reactNativeFactory: RCTReactNativeFactory?\n'
  if (!updated.includes('var launchOptions:')) {
    if (!updated.includes(propertyAnchor)) {
      throw new Error('withIosSceneLifecycle: could not find reactNativeFactory on AppDelegate')
    }
    updated = updated.replace(propertyAnchor, `${LAUNCH_OPTIONS_PROPERTY}\n`)
  }
  return updated
}

function addSceneDelegateSource(project, projectName) {
  const filepath = `${projectName}/SceneDelegate.swift`
  IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
    filepath,
    groupName: projectName,
    project,
    verbose: true,
  })
  return project
}

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (result) => {
    result.modResults.UIApplicationSceneManifest = SCENE_MANIFEST
    return result
  })

  // Finalized, not dangerous: @react-native-firebase/app inserts
  // FirebaseApp.configure() above factory.startReactNative during the dangerous
  // phase. Moving the startup block earlier makes that plugin skip configure().
  config = withFinalizedMod(config, [
    'ios',
    (result) => {
      const projectName = result.modRequest.projectName
      if (!projectName) {
        throw new Error('withIosSceneLifecycle: missing iOS project name')
      }
      const appDelegatePath = path.join(
        result.modRequest.platformProjectRoot,
        projectName,
        'AppDelegate.swift',
      )
      if (!fs.existsSync(appDelegatePath)) {
        throw new Error(`withIosSceneLifecycle: missing ${appDelegatePath}`)
      }
      const adopted = adoptSceneLifecycle(fs.readFileSync(appDelegatePath, 'utf8'))
      fs.writeFileSync(appDelegatePath, adopted)
      fs.writeFileSync(
        path.join(result.modRequest.platformProjectRoot, projectName, 'SceneDelegate.swift'),
        SCENE_DELEGATE,
      )
      return result
    },
  ])

  config = withXcodeProject(config, (result) => {
    const projectName = result.modRequest.projectName
    if (!projectName) {
      throw new Error('withIosSceneLifecycle: missing iOS project name')
    }
    addSceneDelegateSource(result.modResults, projectName)
    return result
  })

  return config
}

module.exports = withIosSceneLifecycle
module.exports.adoptSceneLifecycle = adoptSceneLifecycle
module.exports.WINDOW_BLOCK = WINDOW_BLOCK
