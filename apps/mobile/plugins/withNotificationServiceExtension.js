/**
 * Expo config plugin — adds an iOS Notification Service Extension that
 * downloads `avatarUrl` from the push payload and attaches it before display.
 *
 * APNs payloads must include `mutable-content: 1` (handled server-side in
 * convex/lib/pushProviders.ts).
 */

const {
  withDangerousMod,
  withXcodeProject,
  withEntitlementsPlist,
  IOSConfig,
} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

const EXTENSION_NAME = 'BondfiresNotificationService'
const EXTENSION_BUNDLE_SUFFIX = 'NotificationServiceExtension'

function copyExtensionSources(projectRoot) {
  const sourceDir = path.join(__dirname, 'notification-service-extension')
  const targetDir = path.join(projectRoot, 'ios', EXTENSION_NAME)

  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['NotificationService.h', 'NotificationService.m', 'Info.plist']) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file))
  }

  return targetDir
}

function ensureExtensionTarget(project, bundleIdentifier, deploymentTarget) {
  const extensionBundleId = `${bundleIdentifier}.${EXTENSION_BUNDLE_SUFFIX}`

  // Skip if the target already exists (idempotent prebuild).
  const existing = project.pbxTargetByName(EXTENSION_NAME)
  if (existing) {
    return { extensionBundleId }
  }

  const target = project.addTarget(
    EXTENSION_NAME,
    'app_extension',
    EXTENSION_NAME,
    extensionBundleId,
  )

  // Source files group
  const groupKey = project.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME)
  const objects = project.hash.project.objects
  objects.PBXGroup ??= {}
  const mainGroupId = project.getFirstProject().firstProject.mainGroup
  if (objects.PBXGroup[mainGroupId] && Array.isArray(objects.PBXGroup[mainGroupId].children)) {
    objects.PBXGroup[mainGroupId].children.push({ value: groupKey, comment: EXTENSION_NAME })
  }

  const sourceFiles = ['NotificationService.m', 'NotificationService.h', 'Info.plist']
  for (const fileName of sourceFiles) {
    const filePath = path.join(EXTENSION_NAME, fileName)
    const fileRef = project.addFile(filePath, groupKey, {
      target: target.uuid,
      lastKnownFileType: fileName.endsWith('.plist')
        ? 'text.plist.xml'
        : fileName.endsWith('.h')
          ? 'sourcecode.c.h'
          : 'sourcecode.c.objc',
    })

    if (fileName.endsWith('.m') && fileRef) {
      project.addToPbxBuildFileSection(fileRef)
      project.addToPbxSourcesBuildPhase(target.uuid, fileRef)
    }
  }

  // Build settings for the extension target
  const configurations = project.pbxXCBuildConfigurationSection()
  for (const key of Object.keys(configurations)) {
    const config = configurations[key]
    if (typeof config !== 'object' || !config.buildSettings) continue
    if (config.buildSettings.PRODUCT_NAME !== `"${EXTENSION_NAME}"`) continue

    config.buildSettings.INFOPLIST_FILE = `${EXTENSION_NAME}/Info.plist`
    config.buildSettings.CLANG_ENABLE_MODULES = 'YES'
    config.buildSettings.LD_RUNPATH_SEARCH_PATHS =
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"'
    config.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"'
    config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget
    config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = extensionBundleId
    config.buildSettings.CODE_SIGN_STYLE = 'Automatic'
    config.buildSettings.CODE_SIGN_ENTITLEMENTS = `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`
  }

  // Embed the extension in the main app
  if (typeof project.addBuildPhase === 'function') {
    try {
      project.addBuildPhase(
        [],
        'PBXCopyFilesBuildPhase',
        'Embed App Extensions',
        project.getFirstTarget().uuid,
        'app_extension',
        '',
      )
    } catch {
      // Older xcode lib variants may already have the phase.
    }
  }

  return { extensionBundleId }
}

function writeExtensionEntitlements(projectRoot, appGroupId) {
  const entitlementsPath = path.join(
    projectRoot,
    'ios',
    EXTENSION_NAME,
    `${EXTENSION_NAME}.entitlements`,
  )
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroupId}</string>
  </array>
</dict>
</plist>
`
  fs.writeFileSync(entitlementsPath, contents)
}

const withNotificationServiceExtension = (config) => {
  const bundleIdentifier = config.ios?.bundleIdentifier
  if (!bundleIdentifier) {
    throw new Error('withNotificationServiceExtension requires ios.bundleIdentifier')
  }

  const deploymentTarget =
    config.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
    )?.[1]?.ios?.deploymentTarget || '16.4'

  const appGroupId = `group.${bundleIdentifier}`

  // Ensure the main app has the App Group (shared with the extension).
  config = withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups']
    if (Array.isArray(groups)) {
      if (!groups.includes(appGroupId)) groups.push(appGroupId)
    } else {
      cfg.modResults['com.apple.security.application-groups'] = [appGroupId]
    }
    return cfg
  })

  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      copyExtensionSources(cfg.modRequest.projectRoot)
      writeExtensionEntitlements(cfg.modRequest.projectRoot, appGroupId)
      return cfg
    },
  ])

  config = withXcodeProject(config, (cfg) => {
    ensureExtensionTarget(cfg.modResults, bundleIdentifier, deploymentTarget)

    // Keep the main app's development team / signing aligned when possible.
    try {
      IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
    } catch {
      // Non-fatal — EAS manages signing.
    }

    return cfg
  })

  return config
}

module.exports = withNotificationServiceExtension
