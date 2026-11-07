import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

// Each local release keeps `apps/mobile/build/symbols/<version>-<platform>/eas`, the
// full EAS working directory (node_modules, Pods, Gradle output): ~5 GB for iOS and
// ~11 GB for Android. Crash diagnostics only need a few files from it. Trimming
// moves those files up one level and deletes the working directory.

const IOS_DSYM_DIR =
  'eas/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/Bondfires/BuildProductsPath/Release-iphoneos'
const IOS_DSYMS = ['Bondfires.app.dSYM', 'BondfiresNotificationService.appex.dSYM']
const ANDROID_BUILD_DIR = 'eas/build/apps/mobile/android/app/build'
const ANDROID_BUNDLE_MAP = 'generated/sourcemaps/react/release/index.android.bundle.map'
const ANDROID_SYMBOL_TABLES =
  'intermediates/native_symbol_tables/release/extractReleaseNativeSymbolTables/out'

const SYMBOL_DIR_PATTERN = /^(\d+\.\d+\.\d+)-(ios|android)$/

function isNonEmptyFile(path) {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory()
}

function moveIfPresent(from, to) {
  if (existsSync(from) && !existsSync(to)) renameSync(from, to)
}

/** Whether the evidence manifest recorded a finished build for this platform. */
export function wasPlatformBuilt(buildDir, version, platform) {
  const manifest = join(buildDir, `release-${version}.json`)
  if (!existsSync(manifest)) return null
  const events = JSON.parse(readFileSync(manifest, 'utf8')).events ?? []
  return events.some((event) => event.name === 'platform-built' && event.platform === platform)
}

/** Move the kept diagnostics out of `eas/`. Returns the files still missing. */
export function extractSymbols(dir, platform) {
  if (platform === 'ios') {
    const dsyms = join(dir, 'dSYMs')
    mkdirSync(dsyms, { recursive: true })
    for (const name of IOS_DSYMS) moveIfPresent(join(dir, IOS_DSYM_DIR, name), join(dsyms, name))
    return [
      ...IOS_DSYMS.filter((name) => !isDirectory(join(dsyms, name))).map((name) => `dSYMs/${name}`),
      ...(isNonEmptyFile(join(dir, 'main.jsbundle.map')) ? [] : ['main.jsbundle.map']),
    ]
  }

  moveIfPresent(
    join(dir, ANDROID_BUILD_DIR, ANDROID_BUNDLE_MAP),
    join(dir, 'index.android.bundle.map'),
  )
  moveIfPresent(
    join(dir, ANDROID_BUILD_DIR, ANDROID_SYMBOL_TABLES),
    join(dir, 'native-symbol-tables'),
  )
  return [
    ...(isNonEmptyFile(join(dir, 'index.android.bundle.map')) ? [] : ['index.android.bundle.map']),
    ...(isDirectory(join(dir, 'native-symbol-tables')) ? [] : ['native-symbol-tables']),
  ]
}

/**
 * Trim every `<version>-<platform>` symbol folder that still holds an `eas/` working
 * directory. A build the evidence manifest marks as built keeps its working directory
 * if any diagnostic file is missing; a build that never finished has nothing worth
 * keeping and is removed outright. Folders without a manifest are left alone.
 */
export function trimReleaseSymbols(buildDir, { only = [], skip = [] } = {}) {
  const symbolsDir = join(buildDir, 'symbols')
  if (!isDirectory(symbolsDir)) return []
  const results = []
  for (const name of readdirSync(symbolsDir).sort()) {
    const match = SYMBOL_DIR_PATTERN.exec(name)
    if (!match) continue
    if (only.length > 0 && !only.includes(name)) continue
    if (skip.includes(name)) continue
    const dir = join(symbolsDir, name)
    const workDir = join(dir, 'eas')
    if (!isDirectory(workDir)) continue
    const [, version, platform] = match
    const built = wasPlatformBuilt(buildDir, version, platform)
    if (built === null) {
      results.push({ name, action: 'kept', reason: 'no release evidence manifest' })
      continue
    }
    if (!built) {
      rmSync(dir, { recursive: true, force: true })
      results.push({ name, action: 'removed', reason: 'build never finished' })
      continue
    }
    const missing = extractSymbols(dir, platform)
    if (missing.length > 0) {
      results.push({ name, action: 'kept', reason: `missing ${missing.join(', ')}` })
      continue
    }
    rmSync(workDir, { recursive: true, force: true })
    results.push({ name, action: 'trimmed' })
  }
  return results
}
