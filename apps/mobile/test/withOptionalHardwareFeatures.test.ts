import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { markFeaturesOptional, OPTIONAL_FEATURES } =
  require('../plugins/withOptionalHardwareFeatures.js') as {
    markFeaturesOptional: (manifest: {
      'uses-feature'?: { $: Record<string, string> } | Array<{ $: Record<string, string> }>
    }) => void
    OPTIONAL_FEATURES: readonly string[]
  }

describe('markFeaturesOptional', () => {
  it('declares portrait and wifi as optional when the manifest omits them', () => {
    const manifest: { 'uses-feature'?: Array<{ $: Record<string, string> }> } = {}

    markFeaturesOptional(manifest)

    expect(manifest['uses-feature']?.map((feature) => feature.$)).toEqual(
      OPTIONAL_FEATURES.map((name) => ({
        'android:name': name,
        'android:required': 'false',
      })),
    )
  })

  it('overrides an existing required feature without duplicating it', () => {
    const manifest: {
      'uses-feature': { $: Record<string, string> } | Array<{ $: Record<string, string> }>
    } = {
      'uses-feature': {
        $: {
          'android:name': 'android.hardware.wifi',
          'android:required': 'true',
        },
      },
    }

    markFeaturesOptional(manifest)

    const features = manifest['uses-feature']
    if (!Array.isArray(features)) throw new Error('expected uses-feature to be normalized')
    const wifi = features.filter((feature) => feature.$['android:name'] === 'android.hardware.wifi')
    expect(wifi).toHaveLength(1)
    expect(wifi[0].$['android:required']).toBe('false')
    expect(features.map((feature) => feature.$['android:name'])).toEqual([
      'android.hardware.wifi',
      'android.hardware.screen.portrait',
    ])
  })

  it('leaves unrelated hardware features alone', () => {
    const manifest = {
      'uses-feature': [
        {
          $: {
            'android:name': 'android.hardware.camera',
            'android:required': 'true',
          },
        },
      ],
    }

    markFeaturesOptional(manifest)

    expect(manifest['uses-feature'][0].$).toEqual({
      'android:name': 'android.hardware.camera',
      'android:required': 'true',
    })
  })
})
