import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AndroidConfig, type ConfigPlugin, compileModsAsync } from 'expo/config-plugins'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const withOptionalHardwareFeatures =
  require('../plugins/withOptionalHardwareFeatures.js') as ConfigPlugin

async function prebuildFeatures(initialFeatures: string) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bondfires-android-manifest-'))
  try {
    const manifestPath = join(projectRoot, 'android/app/src/main/AndroidManifest.xml')
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">${initialFeatures}</manifest>`,
    )

    // Run the mod twice against the same file, as when prebuilding an existing project.
    for (let run = 0; run < 2; run++) {
      await compileModsAsync(
        withOptionalHardwareFeatures({ name: 'Bondfires', slug: 'bondfires' }),
        {
          projectRoot,
          platforms: ['android'],
        },
      )
    }

    const { manifest } = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath)
    return manifest['uses-feature']?.map((feature) => feature.$)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}

describe('withOptionalHardwareFeatures', () => {
  const portrait = {
    'android:name': 'android.hardware.screen.portrait',
    'android:required': 'false',
  }
  const wifi = { 'android:name': 'android.hardware.wifi', 'android:required': 'false' }

  it('declares both features exactly once in a fresh manifest', async () => {
    expect(await prebuildFeatures('')).toEqual([portrait, wifi])
  })

  it('updates an existing declaration and preserves required camera support', async () => {
    const features = await prebuildFeatures(`
      <uses-feature android:name="android.hardware.wifi" />
      <uses-feature android:name="android.hardware.camera" android:required="true" />
    `)

    expect(features).toEqual([
      wifi,
      { 'android:name': 'android.hardware.camera', 'android:required': 'true' },
      portrait,
    ])
  })
})
