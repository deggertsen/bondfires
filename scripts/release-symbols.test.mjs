import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trimReleaseSymbols } from './lib/release-symbols.mjs'

const IOS_DSYM_DIR =
  'eas/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/Bondfires/BuildProductsPath/Release-iphoneos'
const ANDROID_BUILD_DIR = 'eas/build/apps/mobile/android/app/build'

let buildDir
afterEach(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true })
})

function file(path, contents = 'x') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function manifest(version, builtPlatforms) {
  file(
    join(buildDir, `release-${version}.json`),
    JSON.stringify({
      events: builtPlatforms.map((platform) => ({ name: 'platform-built', platform })),
    }),
  )
}

function iosBuild(version, { withDsyms = true } = {}) {
  const dir = join(buildDir, 'symbols', `${version}-ios`)
  file(join(dir, 'main.jsbundle.map'))
  file(join(dir, 'eas/build/node_modules/huge.js'))
  if (withDsyms) {
    file(join(dir, IOS_DSYM_DIR, 'Bondfires.app.dSYM/Contents/Info.plist'))
    file(join(dir, IOS_DSYM_DIR, 'BondfiresNotificationService.appex.dSYM/Contents/Info.plist'))
  }
  return dir
}

function androidBuild(version) {
  const dir = join(buildDir, 'symbols', `${version}-android`)
  file(join(dir, ANDROID_BUILD_DIR, 'generated/sourcemaps/react/release/index.android.bundle.map'))
  file(
    join(
      dir,
      ANDROID_BUILD_DIR,
      'intermediates/native_symbol_tables/release/extractReleaseNativeSymbolTables/out/arm64-v8a/libjsi.so.sym',
    ),
  )
  file(join(dir, 'eas/build/node_modules/huge.js'))
  return dir
}

describe('trimReleaseSymbols', () => {
  it('keeps crash diagnostics and deletes the working directory of finished builds', () => {
    buildDir = mkdtempSync(join(tmpdir(), 'release-symbols-'))
    manifest('1.0.200', ['ios', 'android'])
    const ios = iosBuild('1.0.200')
    const android = androidBuild('1.0.200')

    expect(trimReleaseSymbols(buildDir)).toEqual([
      { name: '1.0.200-android', action: 'trimmed' },
      { name: '1.0.200-ios', action: 'trimmed' },
    ])
    expect(existsSync(join(ios, 'eas'))).toBe(false)
    expect(existsSync(join(ios, 'main.jsbundle.map'))).toBe(true)
    expect(existsSync(join(ios, 'dSYMs/Bondfires.app.dSYM/Contents/Info.plist'))).toBe(true)
    expect(existsSync(join(ios, 'dSYMs/BondfiresNotificationService.appex.dSYM'))).toBe(true)
    expect(existsSync(join(android, 'eas'))).toBe(false)
    expect(existsSync(join(android, 'index.android.bundle.map'))).toBe(true)
    expect(existsSync(join(android, 'native-symbol-tables/arm64-v8a/libjsi.so.sym'))).toBe(true)
    // Already trimmed folders are left alone on the next run.
    expect(trimReleaseSymbols(buildDir)).toEqual([])
  })

  it('removes builds that never finished and keeps finished ones missing diagnostics', () => {
    buildDir = mkdtempSync(join(tmpdir(), 'release-symbols-'))
    manifest('1.0.201', ['ios'])
    const unfinished = androidBuild('1.0.201')
    const missing = iosBuild('1.0.201', { withDsyms: false })

    expect(trimReleaseSymbols(buildDir)).toEqual([
      { name: '1.0.201-android', action: 'removed', reason: 'build never finished' },
      {
        name: '1.0.201-ios',
        action: 'kept',
        reason: 'missing dSYMs/Bondfires.app.dSYM, dSYMs/BondfiresNotificationService.appex.dSYM',
      },
    ])
    expect(existsSync(unfinished)).toBe(false)
    expect(existsSync(join(missing, 'eas'))).toBe(true)
  })

  it('leaves folders without release evidence and honours --only / --skip', () => {
    buildDir = mkdtempSync(join(tmpdir(), 'release-symbols-'))
    const orphan = iosBuild('1.0.100')
    manifest('1.0.202', ['ios', 'android'])
    iosBuild('1.0.202')
    androidBuild('1.0.202')

    expect(trimReleaseSymbols(buildDir, { only: ['1.0.100-ios'] })).toEqual([
      { name: '1.0.100-ios', action: 'kept', reason: 'no release evidence manifest' },
    ])
    expect(existsSync(join(orphan, 'eas'))).toBe(true)
    expect(trimReleaseSymbols(buildDir, { skip: ['1.0.100-ios', '1.0.202-android'] })).toEqual([
      { name: '1.0.202-ios', action: 'trimmed' },
    ])
  })
})
