import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const IOS_DSYM_DIR =
  'eas/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/Bondfires/BuildProductsPath/Release-iphoneos'
const IOS_DSYMS = ['Bondfires.app.dSYM', 'BondfiresNotificationService.appex.dSYM']
const ANDROID_BUILD_DIR = 'eas/build/apps/mobile/android/app/build'
const ANDROID_BUNDLE_MAP = 'generated/sourcemaps/react/release/index.android.bundle.map'
const ANDROID_SYMBOL_TABLES =
  'intermediates/native_symbol_tables/release/extractReleaseNativeSymbolTables/out'

export const SYMBOL_DIR_PATTERN = /^(\d+\.\d+\.\d+)-(ios|android)$/

function stat(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Do not retain links into the working directory we are about to delete, or
// traverse links to another build's diagnostics while extracting files.
function localPath(root, relative) {
  let path = root
  for (const part of relative.split('/')) {
    path = join(path, part)
    if (stat(path)?.isSymbolicLink()) throw new Error(`symbolic link: ${relative}`)
  }
  return path
}

function nonEmptyFiles(path) {
  const info = stat(path)
  if (info?.isFile() && info.size > 0) return [path]
  if (!info?.isDirectory()) throw new Error(`missing, empty, or linked diagnostic: ${path}`)
  return readdirSync(path).flatMap((name) => nonEmptyFiles(join(path, name)))
}

function validateDiagnostic(path, kind) {
  const files = nonEmptyFiles(path)
  if (kind === 'file' && !stat(path)?.isFile()) throw new Error(`expected file: ${path}`)
  if (kind === 'dsym') {
    if (!stat(join(path, 'Contents/Info.plist'))?.isFile()) {
      throw new Error(`missing dSYM Info.plist: ${path}`)
    }
    const dwarfDir = join(path, 'Contents/Resources/DWARF')
    if (!files.some((file) => dirname(file) === dwarfDir)) {
      throw new Error(`missing dSYM DWARF data: ${path}`)
    }
  }
  if (kind === 'native' && !files.some((file) => file.endsWith('.sym'))) {
    throw new Error(`missing native symbol tables: ${path}`)
  }
}

function requireBuiltPlatform(buildDir, version, platform) {
  const path = join(buildDir, `release-${version}.json`)
  if (!stat(path)?.isFile()) throw new Error('no regular release evidence manifest')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.release?.version !== version ||
    !Array.isArray(manifest.events)
  ) {
    throw new Error('invalid release evidence manifest')
  }
  if (
    !manifest.events.some(
      (event) => event?.name === 'platform-built' && event.platform === platform,
    )
  ) {
    throw new Error('no completed build recorded; may be active or interrupted')
  }
}

function diagnosticPlan(dir, platform) {
  if (platform === 'android') {
    return [
      [join(ANDROID_BUILD_DIR, ANDROID_BUNDLE_MAP), 'index.android.bundle.map', 'file'],
      [join(ANDROID_BUILD_DIR, ANDROID_SYMBOL_TABLES), 'native-symbol-tables', 'native'],
    ]
  }
  const source = localPath(dir, IOS_DSYM_DIR)
  const saved = localPath(dir, 'dSYMs')
  // Preserve additional framework/extension dSYMs as well as the two required bundles.
  const names = new Set(IOS_DSYMS)
  for (const path of [source, saved]) {
    if (stat(path)?.isDirectory()) {
      for (const name of readdirSync(path)) if (name.endsWith('.dSYM')) names.add(name)
    }
  }
  return [
    ['main.jsbundle.map', 'main.jsbundle.map', 'file'],
    ...[...names].map((name) => [join(IOS_DSYM_DIR, name), `dSYMs/${name}`, 'dsym']),
  ]
}

function extractSymbols(dir, platform) {
  const moves = []
  // Validate the entire plan before moving anything. A destination collision may
  // be from a different attempt at the same version: never silently prefer it.
  for (const [from, to, kind] of diagnosticPlan(dir, platform)) {
    const source = localPath(dir, from)
    const destination = localPath(dir, to)
    const hasSource = stat(source) !== null
    const hasDestination = stat(destination) !== null
    if (source !== destination && hasSource && hasDestination) {
      throw new Error(`diagnostic destination already exists: ${to}`)
    }
    validateDiagnostic(hasSource ? source : destination, kind)
    if (source !== destination && hasSource) moves.push([source, destination])
  }
  for (const [source, destination] of moves) {
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(source, destination)
  }
}

/** Only completed builds with verified, retained diagnostics may lose their EAS directory. */
export function trimReleaseSymbols(buildDir, { only = [], skip = [] } = {}) {
  const symbolsDir = join(buildDir, 'symbols')
  if (!stat(symbolsDir)?.isDirectory()) return []
  const results = []
  for (const name of readdirSync(symbolsDir).sort()) {
    const match = SYMBOL_DIR_PATTERN.exec(name)
    if (!match || (only.length > 0 && !only.includes(name)) || skip.includes(name)) continue
    const dir = join(symbolsDir, name)
    const workDir = join(dir, 'eas')
    try {
      if (!stat(dir)?.isDirectory()) throw new Error('not a regular symbol directory')
      if (!stat(workDir)) continue
      if (!stat(workDir)?.isDirectory()) throw new Error('not a regular EAS directory')
      const [, version, platform] = match
      requireBuiltPlatform(buildDir, version, platform)
      extractSymbols(dir, platform)
      rmSync(workDir, { recursive: true })
      results.push({ name, action: 'trimmed' })
    } catch (error) {
      // One unreadable/corrupt build must not prevent cleanup of other valid builds.
      results.push({ name, action: 'kept', reason: error.message })
    }
  }
  return results
}
