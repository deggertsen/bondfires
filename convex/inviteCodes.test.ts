import { describe, expect, it } from 'vitest'
import {
  generateSecureInviteCode,
  isInviteCodeClaimable,
  isReusableInviteCode,
  isSecureInviteCode,
  LEGACY_INVITE_CODE_CUTOFF_MS,
  normalizeInviteCode,
} from './inviteCodes'

describe('invite code security', () => {
  it('generates migration-distinct, high-entropy formatted codes', () => {
    const codes = new Set<string>()
    for (let index = 0; index < 10_000; index += 1) {
      const code = generateSecureInviteCode()
      expect(isSecureInviteCode(code)).toBe(true)
      codes.add(code)
    }
    expect(codes.size).toBe(10_000)
  })

  it('continues normalizing legacy word codes for lookup', () => {
    expect(normalizeInviteCode('  Amber -- River   Torch ')).toBe('amber-river-torch')
  })

  it('lets compatibility lookups distinguish secure-format links from legacy links', () => {
    expect(isSecureInviteCode('bf-abcd-efgh-ijkl-mnop-qrst')).toBe(true)
    expect(isSecureInviteCode('amber-river-torch')).toBe(false)
  })

  it('never reuses a legacy code and ends its compatibility grace at the cutoff', () => {
    const legacy = { code: 'amber-river-torch', uses: 0 }
    expect(isReusableInviteCode(legacy, LEGACY_INVITE_CODE_CUTOFF_MS - 1)).toBe(false)
    expect(isInviteCodeClaimable(legacy, LEGACY_INVITE_CODE_CUTOFF_MS - 1)).toBe(true)
    expect(isInviteCodeClaimable(legacy, LEGACY_INVITE_CODE_CUTOFF_MS)).toBe(false)
  })

  it('fails closed if a secure-format row is missing its mandatory expiry', () => {
    expect(
      isInviteCodeClaimable(
        { code: 'bf-abcd-efgh-ijkl-mnop-qrst', uses: 0 },
        LEGACY_INVITE_CODE_CUTOFF_MS - 1,
      ),
    ).toBe(false)
  })
})
