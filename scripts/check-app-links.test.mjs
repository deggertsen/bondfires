import { describe, expect, it } from 'vitest'
import {
  validateAasa,
  validateAppLinksContract,
  validateAssetLinks,
  validateExpoAppLinks,
  validateFingerprint,
} from './lib/app-links.mjs'

const PLAY_FINGERPRINT =
  'AA:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F'

describe('App Links validation', () => {
  it('rejects placeholder and malformed certificate fingerprints', () => {
    expect(validateFingerprint('REPLACE_WITH_SHA256_FINGERPRINT_FROM_PLAY_CONSOLE')).toEqual([
      'fingerprint contains a placeholder',
    ])
    expect(validateFingerprint('AA:BB')).toEqual([
      'fingerprint must be a colon-delimited SHA-256 certificate fingerprint',
    ])
    expect(validateFingerprint(PLAY_FINGERPRINT)).toEqual([])
  })

  it('requires the expected Play signing certificate, not merely another valid key', () => {
    const uploadFingerprint = PLAY_FINGERPRINT.replace(/^AA/, 'BB')
    const assetLinks = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'org.bondfires',
          sha256_cert_fingerprints: [uploadFingerprint],
        },
      },
    ]
    expect(
      validateAssetLinks(assetLinks, {
        packageName: 'org.bondfires',
        expectedFingerprints: [PLAY_FINGERPRINT],
      }),
    ).toContain(
      `assetlinks.json is missing expected Play App Signing fingerprint ${PLAY_FINGERPRINT}`,
    )
  })

  it('accepts multiple valid fingerprints when the Play key is included', () => {
    const uploadFingerprint = PLAY_FINGERPRINT.replace(/^AA/, 'BB')
    const assetLinks = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'org.bondfires',
          sha256_cert_fingerprints: [PLAY_FINGERPRINT, uploadFingerprint],
        },
      },
    ]
    expect(
      validateAssetLinks(assetLinks, {
        packageName: 'org.bondfires',
        expectedFingerprints: [PLAY_FINGERPRINT],
      }),
    ).toEqual([])
  })

  it('requires every Apple deep-link path', () => {
    const aasa = {
      applinks: {
        details: [{ appID: 'A9BJ2VA78M.org.bondfires', paths: ['/invite/*'] }],
      },
    }
    expect(
      validateAasa(aasa, {
        appId: 'A9BJ2VA78M.org.bondfires',
        expectedPaths: ['/invite/*', '/personal-bondfire/*'],
      }),
    ).toEqual(['AASA is missing /personal-bondfire/*'])
  })

  it('requires every host/path pair in an auto-verified HTTPS intent filter', () => {
    const expo = {
      android: {
        package: 'org.bondfires',
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            category: ['BROWSABLE', 'DEFAULT'],
            data: [{ scheme: 'https', host: 'bondfires.org', pathPrefix: '/invite/' }],
          },
        ],
      },
      ios: {
        appleTeamId: 'A9BJ2VA78M',
        bundleIdentifier: 'org.bondfires',
        associatedDomains: ['applinks:bondfires.org'],
        entitlements: {
          'com.apple.developer.associated-domains': ['applinks:bondfires.org'],
        },
      },
    }
    expect(
      validateExpoAppLinks(expo, {
        packageName: 'org.bondfires',
        appleAppId: 'A9BJ2VA78M.org.bondfires',
        hosts: ['bondfires.org'],
        androidPathPrefixes: ['/invite/', '/personal-bondfire/'],
      }),
    ).toEqual(['Android autoVerify is missing https://bondfires.org/personal-bondfire/'])
  })

  it('requires every route sample to be covered on Android and Apple', () => {
    expect(
      validateAppLinksContract({
        version: 1,
        packageName: 'org.bondfires',
        appleAppId: 'A9BJ2VA78M.org.bondfires',
        hosts: ['bondfires.org'],
        androidPathPrefixes: ['/invite/'],
        applePaths: ['/invite/*'],
        routeSamples: ['/personal-bondfire/id/code'],
        playAppSigningSha256Fingerprints: [],
        nonPlaySigningSha256Fingerprints: [],
      }),
    ).toEqual([
      'Route sample is not covered by an Android path prefix: /personal-bondfire/id/code',
      'Route sample is not covered by an Apple path: /personal-bondfire/id/code',
    ])
  })

  it('rejects a known non-Play key misclassified as Play signing', () => {
    expect(
      validateAppLinksContract({
        version: 1,
        packageName: 'org.bondfires',
        appleAppId: 'A9BJ2VA78M.org.bondfires',
        hosts: ['bondfires.org'],
        androidPathPrefixes: ['/invite/'],
        applePaths: ['/invite/*'],
        routeSamples: ['/invite/code'],
        playAppSigningSha256Fingerprints: [PLAY_FINGERPRINT],
        nonPlaySigningSha256Fingerprints: [PLAY_FINGERPRINT],
      }),
    ).toEqual([`Play signing fingerprint is also classified as non-Play: ${PLAY_FINGERPRINT}`])
  })
})
