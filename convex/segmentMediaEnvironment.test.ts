import { describe, expect, it } from 'vitest'
import { mediaBackendEnabled, mediaClientEnabled } from '../packages/media/src/environment'

const internal = 'https://lovely-malamute-525.convex.cloud'
const production = 'https://ideal-akita-27.convex.cloud'

describe('segmented media rollout', () => {
  it('requires an explicit production flag independently of internal enablement', () => {
    expect(mediaBackendEnabled(production, undefined, '1')).toBe(false)
    expect(mediaBackendEnabled(production, '0', '1')).toBe(false)
    expect(mediaBackendEnabled(production, '1', undefined)).toBe(true)
    expect(mediaBackendEnabled(internal, undefined, '1')).toBe(true)
    expect(mediaBackendEnabled(internal, '1', undefined)).toBe(true)
    expect(mediaBackendEnabled(internal, undefined, undefined)).toBe(false)
    expect(mediaBackendEnabled('https://unknown.convex.cloud', '1', '1')).toBe(false)
  })
  it('enables only explicitly selected builds with matching deployment ownership', () => {
    expect(mediaClientEnabled('production', production, '1')).toBe(true)
    expect(mediaClientEnabled('internal', internal, '1')).toBe(true)
    expect(mediaClientEnabled('production', production, undefined)).toBe(false)
    expect(mediaClientEnabled('internal', production, '1')).toBe(false)
    expect(mediaClientEnabled('production', internal, '1')).toBe(false)
    expect(mediaClientEnabled('preview', production, '1')).toBe(false)
    expect(mediaClientEnabled('production', 'https://unknown.convex.cloud', '1')).toBe(false)
  })
})
