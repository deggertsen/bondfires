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
// Merge with default watchFolders instead of replacing them
config.watchFolders = [...(config.watchFolders || []), workspaceRoot]

// Configure resolver to look in workspace root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Expo Router's require.context scans all of app/; exclude test files so vitest
// (and its vite dependency) never enter the Hermes bundle.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /\.test\.[jt]sx?$/,
]

// Use official Tamagui Metro plugin for proper monorepo handling
const metroConfig = withTamagui(config, {
  components: ['tamagui'],
  config: './tamagui.config.ts',
})

// EAS local builds unpack inside a tree Watchman may already be watching.
// A production install can overflow fsevents ("UserDropped") and the one-shot
// bundle then misses packages that are on disk. Node's crawler reads the tree.
if (process.env.EAS_BUILD === '1') {
  metroConfig.resolver.useWatchman = false
}

module.exports = metroConfig
