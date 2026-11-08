import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkReleaseDiskSpace } from './check-release-disk-space.mjs'
import { trimReleaseSymbols } from './lib/release-symbols.mjs'

const IOS_DSYM_DIR =
  'eas/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/Bondfires/BuildProductsPath/Release-iphoneos'
const ANDROID_BUILD_DIR = 'eas/build/apps/mobile/android/app/build'
const NATIVE_TABLES =
  'intermediates/native_symbol_tables/release/extractReleaseNativeSymbolTables/out'

let buildDir
beforeEach(() => {
  buildDir = mkdtempSync(join(tmpdir(), 'release-symbols-'))
})
afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true })
})

function file(path, contents = 'x') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function manifest(version, builtPlatforms) {
  file(
    join(buildDir, `release-${version}.json`),
    JSON.stringify({
      schemaVersion: 1,
      release: { version },
      status: 'started',
      events: builtPlatforms.map((platform) => ({ name: 'platform-built', platform })),
    }),
  )
}

function dsym(dir, name, binary) {
  file(join(dir, name, 'Contents/Info.plist'))
  file(join(dir, name, 'Contents/Resources/DWARF', binary), `${binary} symbols`)
}

function iosBuild(version) {
  const dir = join(buildDir, 'symbols', `${version}-ios`)
  file(join(dir, 'main.jsbundle.map'), 'ios map')
  file(join(dir, 'eas/build/node_modules/huge.js'))
  dsym(join(dir, IOS_DSYM_DIR), 'Bondfires.app.dSYM', 'Bondfires')
  dsym(
    join(dir, IOS_DSYM_DIR),
    'BondfiresNotificationService.appex.dSYM',
    'BondfiresNotificationService',
  )
  return dir
}

function androidBuild(version) {
  const dir = join(buildDir, 'symbols', `${version}-android`)
  file(
    join(dir, ANDROID_BUILD_DIR, 'generated/sourcemaps/react/release/index.android.bundle.map'),
    'android map',
  )
  file(join(dir, ANDROID_BUILD_DIR, NATIVE_TABLES, 'arm64-v8a/libjsi.so.sym'), 'native symbols')
  file(join(dir, 'eas/build/node_modules/huge.js'))
  return dir
}

function expectKept(dir, reason) {
  expect(trimReleaseSymbols(buildDir)).toEqual([
    { name: dir.split('/').at(-1), action: 'kept', reason: expect.stringContaining(reason) },
  ])
  expect(existsSync(join(dir, 'eas'))).toBe(true)
}

describe('trimReleaseSymbols', () => {
  it('retains exact diagnostic contents, including additional dSYMs, and is repeatable', () => {
    manifest('1.0.200', ['ios', 'android'])
    const ios = iosBuild('1.0.200')
    const android = androidBuild('1.0.200')
    dsym(join(ios, IOS_DSYM_DIR), 'Extra.framework.dSYM', 'Extra')

    expect(trimReleaseSymbols(buildDir)).toEqual([
      { name: '1.0.200-android', action: 'trimmed' },
      { name: '1.0.200-ios', action: 'trimmed' },
    ])
    expect(existsSync(join(ios, 'eas'))).toBe(false)
    expect(readFileSync(join(ios, 'main.jsbundle.map'), 'utf8')).toBe('ios map')
    for (const [name, binary] of [
      ['Bondfires.app.dSYM', 'Bondfires'],
      ['BondfiresNotificationService.appex.dSYM', 'BondfiresNotificationService'],
      ['Extra.framework.dSYM', 'Extra'],
    ]) {
      expect(
        readFileSync(join(ios, 'dSYMs', name, 'Contents/Resources/DWARF', binary), 'utf8'),
      ).toBe(`${binary} symbols`)
    }
    expect(existsSync(join(android, 'eas'))).toBe(false)
    expect(readFileSync(join(android, 'index.android.bundle.map'), 'utf8')).toBe('android map')
    expect(
      readFileSync(join(android, 'native-symbol-tables/arm64-v8a/libjsi.so.sym'), 'utf8'),
    ).toBe('native symbols')
    expect(trimReleaseSymbols(buildDir)).toEqual([])
  })

  it.each(['started', 'failed', 'complete'])(
    'keeps unrecorded builds even when the release is %s',
    (status) => {
      manifest('1.0.201', ['ios'])
      const path = join(buildDir, 'release-1.0.201.json')
      const evidence = JSON.parse(readFileSync(path, 'utf8'))
      evidence.status = status
      file(path, JSON.stringify(evidence))
      const dir = androidBuild('1.0.201')
      expectKept(dir, 'no completed build recorded')
      expect(existsSync(join(dir, ANDROID_BUILD_DIR, NATIVE_TABLES))).toBe(true)
    },
  )

  it.each([
    ['missing', undefined],
    ['invalid JSON', '{'],
    ['missing events', JSON.stringify({ schemaVersion: 1, release: { version: '1.0.202' } })],
    [
      'wrong version',
      JSON.stringify({
        schemaVersion: 1,
        release: { version: '9.9.9' },
        events: [{ name: 'platform-built', platform: 'ios' }],
      }),
    ],
  ])('keeps a build with %s evidence and continues trimming other builds', (_, evidence) => {
    const kept = iosBuild('1.0.202')
    if (evidence !== undefined) file(join(buildDir, 'release-1.0.202.json'), evidence)
    manifest('1.0.203', ['android'])
    androidBuild('1.0.203')
    expect(trimReleaseSymbols(buildDir).map(({ action }) => action)).toEqual(['kept', 'trimmed'])
    expect(existsSync(join(kept, 'eas'))).toBe(true)
  })

  it('does not move any files when a required dSYM lacks DWARF data', () => {
    manifest('1.0.204', ['ios'])
    const dir = iosBuild('1.0.204')
    rmSync(join(dir, IOS_DSYM_DIR, 'BondfiresNotificationService.appex.dSYM/Contents/Resources'), {
      recursive: true,
    })
    expectKept(dir, 'missing dSYM DWARF data')
    expect(existsSync(join(dir, IOS_DSYM_DIR, 'Bondfires.app.dSYM'))).toBe(true)
    expect(existsSync(join(dir, 'dSYMs'))).toBe(false)
  })

  it.each([
    'empty table directory',
    'empty map',
    'symbol link',
    'source parent link',
    'destination collision',
  ])('keeps Android work when it finds an %s', (problem) => {
    manifest('1.0.205', ['android'])
    const dir = androidBuild('1.0.205')
    const tables = join(dir, ANDROID_BUILD_DIR, NATIVE_TABLES)
    if (problem === 'empty table directory') rmSync(join(tables, 'arm64-v8a'), { recursive: true })
    if (problem === 'empty map')
      file(
        join(dir, ANDROID_BUILD_DIR, 'generated/sourcemaps/react/release/index.android.bundle.map'),
        '',
      )
    if (problem === 'symbol link')
      symlinkSync(join(dir, 'eas/build/node_modules/huge.js'), join(tables, 'linked.sym'))
    if (problem === 'source parent link') {
      renameSync(join(dir, ANDROID_BUILD_DIR), join(buildDir, 'external-build'))
      symlinkSync(join(buildDir, 'external-build'), join(dir, ANDROID_BUILD_DIR))
    }
    if (problem === 'destination collision')
      file(join(dir, 'index.android.bundle.map'), 'older map')
    expectKept(dir, '')
    if (problem === 'destination collision')
      expect(readFileSync(join(dir, 'index.android.bundle.map'), 'utf8')).toBe('older map')
  })

  it('resumes an extraction interrupted between moves', () => {
    manifest('1.0.206', ['ios'])
    const dir = iosBuild('1.0.206')
    mkdirSync(join(dir, 'dSYMs'))
    renameSync(join(dir, IOS_DSYM_DIR, 'Bondfires.app.dSYM'), join(dir, 'dSYMs/Bondfires.app.dSYM'))
    expect(trimReleaseSymbols(buildDir)).toEqual([{ name: '1.0.206-ios', action: 'trimmed' }])
    expect(
      readFileSync(
        join(dir, 'dSYMs/Bondfires.app.dSYM/Contents/Resources/DWARF/Bondfires'),
        'utf8',
      ),
    ).toBe('Bondfires symbols')
  })

  it('does not follow symbol-folder or EAS-directory links', () => {
    manifest('1.0.207', ['ios'])
    const dir = iosBuild('1.0.207')
    renameSync(join(dir, 'eas'), join(buildDir, 'external-eas'))
    symlinkSync(join(buildDir, 'external-eas'), join(dir, 'eas'))
    expectKept(dir, 'not a regular EAS directory')
    renameSync(dir, join(buildDir, 'external-symbols'))
    symlinkSync(join(buildDir, 'external-symbols'), dir)
    expectKept(dir, 'not a regular symbol directory')
    expect(existsSync(join(buildDir, 'external-eas/build/node_modules/huge.js'))).toBe(true)
  })

  it('honours --only and --skip together', () => {
    manifest('1.0.208', ['ios', 'android'])
    const ios = iosBuild('1.0.208')
    androidBuild('1.0.208')
    expect(trimReleaseSymbols(buildDir, { only: ['1.0.208-ios'], skip: ['1.0.208-ios'] })).toEqual(
      [],
    )
    expect(trimReleaseSymbols(buildDir, { only: ['1.0.208-android'] })).toEqual([
      { name: '1.0.208-android', action: 'trimmed' },
    ])
    expect(existsSync(join(ios, 'eas'))).toBe(true)
  })

  it.each([['--only'], ['--skip', '--only'], ['--skip', 'typo'], ['--unknown', '1.0.208-ios']])(
    'rejects invalid CLI arguments before touching any build: %j',
    (...args) => {
      expect(() =>
        execFileSync(process.execPath, [resolve('scripts/trim-release-symbols.mjs'), ...args], {
          stdio: 'pipe',
        }),
      ).toThrow()
    },
  )
})

describe('release disk preflight', () => {
  it.each(['', '-1', 'NaN', 'Infinity', '25GB', '1 + 2', '0'])(
    'rejects invalid thresholds: %s',
    (minimum) => {
      expect(() => checkReleaseDiskSpace(buildDir, minimum)).toThrow('must be a positive number')
    },
  )
  it('measures available space and rejects insufficient space', () => {
    const freeGb = checkReleaseDiskSpace(buildDir, '0.001')
    expect(freeGb).toBeGreaterThan(0)
    expect(() => checkReleaseDiskSpace(buildDir, String(freeGb + 1000))).toThrow(
      'local release builds need',
    )
  })
})
