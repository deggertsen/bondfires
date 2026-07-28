import { describe, expect, it } from 'vitest'
import {
  chooseAndroidUpdateType,
  isAppUpdateRequired,
} from '../../../packages/app/src/utils/forceUpdatePolicy'

describe('isAppUpdateRequired', () => {
  it('requires an update only when the installed version is below the configured minimum', () => {
    expect(isAppUpdateRequired('1.0.46', '1.0.76')).toBe(true)
    expect(isAppUpdateRequired('1.0.76', '1.0.76')).toBe(false)
    expect(isAppUpdateRequired('1.1.0', '1.0.76')).toBe(false)
  })

  it('treats omitted version segments as zero', () => {
    expect(isAppUpdateRequired('1.0', '1.0.0')).toBe(false)
    expect(isAppUpdateRequired('1', '1.0.1')).toBe(true)
  })

  it('does not gate when no valid minimum version is configured', () => {
    expect(isAppUpdateRequired('1.0.46', null)).toBe(false)
    expect(isAppUpdateRequired('1.0.46', 'not-a-version')).toBe(false)
  })

  it('gates an unidentifiable client when the configured minimum is valid', () => {
    expect(isAppUpdateRequired(undefined, '1.0.76')).toBe(true)
    expect(isAppUpdateRequired('not-a-version', '1.0.76')).toBe(true)
  })
})

describe('chooseAndroidUpdateType', () => {
  const bothModes = {
    updateAvailable: true,
    flexibleAllowed: true,
    immediateAllowed: true,
  }

  it('honors the configured delivery priority when both modes are available', () => {
    expect(chooseAndroidUpdateType('flexible', bothModes)).toBe('flexible')
    expect(chooseAndroidUpdateType('immediate', bothModes)).toBe('immediate')
  })

  it('falls back to the available native mode', () => {
    expect(
      chooseAndroidUpdateType('flexible', {
        updateAvailable: true,
        immediateAllowed: true,
      }),
    ).toBe('immediate')
    expect(
      chooseAndroidUpdateType('immediate', {
        updateAvailable: true,
        flexibleAllowed: true,
      }),
    ).toBe('flexible')
  })

  it('uses the store fallback when no native update can be delivered', () => {
    expect(chooseAndroidUpdateType('flexible', { updateAvailable: false })).toBeNull()
    expect(chooseAndroidUpdateType('immediate', { updateAvailable: true })).toBeNull()
  })
})
