import { describe, expect, it } from 'vitest'
import { normalizeAppVersion } from './appVersion'

describe('normalizeAppVersion', () => {
  it('accepts store-compatible semantic versions and trims whitespace', () => {
    expect(normalizeAppVersion(' 1.2.3 ')).toBe('1.2.3')
    expect(normalizeAppVersion('0.0.0')).toBe('0.0.0')
    expect(normalizeAppVersion('999999.12.4')).toBe('999999.12.4')
  })

  it.each([
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-beta',
    '01.2.3',
    '1.-2.3',
    '',
  ])('rejects invalid version %j', (version) => {
    expect(() => normalizeAppVersion(version)).toThrow('Version must use major.minor.patch format')
  })

  it('rejects unreasonably large components', () => {
    expect(() => normalizeAppVersion('1000000.0.0')).toThrow(
      'Version components must not exceed 999999',
    )
  })
})
