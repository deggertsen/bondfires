// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { withTamagui } = require('@tamagui/metro-plugin')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(__dirname, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// Required for react-native-mmkv
config.resolver.sourceExts.push('cjs')

// Ensure proper handling of native modules
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== 'svg')
config.resolver.sourceExts.push('svg')

// Configure Metro to watch the workspace root and resolve modules from it
config.watchFolders = [workspaceRoot]

// Configure resolver to look in workspace root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Use official Tamagui Metro plugin for proper monorepo handling
module.exports = withTamagui(config, {
  components: ['tamagui'],
  config: './tamagui.config.ts',
})

