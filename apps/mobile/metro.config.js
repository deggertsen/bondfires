// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')
const fs = require('fs')

// #region agent log
const logPath = '/Volumes/Repos/bondfires/.cursor/debug.log'
const log = (data) => {
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ...data, timestamp: Date.now(), sessionId: 'debug-session' }) + '\n')
  } catch (e) {}
}
// #endregion

// #region agent log
log({ location: 'metro.config.js:init', message: 'Metro config loading', data: { __dirname, cwd: process.cwd() }, hypothesisId: 'A' })
// #endregion

const projectRoot = __dirname
const workspaceRoot = path.resolve(__dirname, '../..')

// #region agent log
log({ location: 'metro.config.js:paths', message: 'Path resolution', data: { projectRoot, workspaceRoot, convexPath: path.join(workspaceRoot, 'convex/_generated/api') }, hypothesisId: 'B' })
// #endregion

// Check if convex files exist
const convexApiPath = path.join(workspaceRoot, 'convex/_generated/api.js')
const convexApiExists = fs.existsSync(convexApiPath)

// #region agent log
log({ location: 'metro.config.js:fileCheck', message: 'Convex file existence check', data: { convexApiPath, exists: convexApiExists }, hypothesisId: 'E' })
// #endregion

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// #region agent log
log({ location: 'metro.config.js:defaultConfig', message: 'Default config created', data: { watchFolders: config.watchFolders, projectRoot: config.projectRoot }, hypothesisId: 'C' })
// #endregion

// Required for react-native-mmkv
config.resolver.sourceExts.push('cjs')

// Ensure proper handling of native modules
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== 'svg')
config.resolver.sourceExts.push('svg')

// Configure Metro to watch the workspace root and resolve modules from it
config.watchFolders = [workspaceRoot, projectRoot]

// #region agent log
log({ location: 'metro.config.js:watchFolders', message: 'Watch folders configured', data: { watchFolders: config.watchFolders }, hypothesisId: 'A' })
// #endregion

// Configure resolver to look in workspace root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// #region agent log
log({ location: 'metro.config.js:nodeModules', message: 'Node modules paths configured', data: { nodeModulesPaths: config.resolver.nodeModulesPaths }, hypothesisId: 'D' })
// #endregion

// #region agent log
log({ location: 'metro.config.js:final', message: 'Metro config final state', data: { watchFolders: config.watchFolders, projectRoot: config.projectRoot, resolver: { sourceExts: config.resolver.sourceExts } }, hypothesisId: 'A,B,C,D' })
// #endregion

module.exports = config

