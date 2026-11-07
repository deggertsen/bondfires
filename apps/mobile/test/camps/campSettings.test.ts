import { describe, expect, it } from 'vitest'
import type { CampRulesInput } from '../../../../convex/lib/campSettingsPolicy'
import {
  accessFromChoice,
  campRulePills,
  choiceFromAccess,
  describeAccess,
  describeParticipation,
  describeWhoCanJoin,
  parseLimitInput,
} from '../../lib/campSettings'

const rules: CampRulesInput = {
  gender: 'any',
  minAge: null,
  maxAge: null,
  allowedTiers: ['free', 'plus', 'premium', 'pro'],
  visibilityMode: 'gate',
  maxDurationMinutes: null,
  maxResponses: null,
  requiresTradeTags: false,
  guidelines: [],
}

describe('camp visibility choice', () => {
  it('maps public/private plus join mode onto access and back', () => {
    expect(accessFromChoice({ visibility: 'public', join: 'open' })).toBe('open')
    expect(accessFromChoice({ visibility: 'public', join: 'approval' })).toBe('approval')
    // Join mode is irrelevant once private.
    expect(accessFromChoice({ visibility: 'private', join: 'open' })).toBe('invite')
    for (const access of ['open', 'approval', 'invite'] as const) {
      expect(accessFromChoice(choiceFromAccess(access))).toBe(access)
    }
  })

  it('describes each access level for the settings row', () => {
    expect(describeAccess('approval').title).toBe('Public · Approval required')
    expect(describeAccess('invite').detail).toContain('You spark')
  })
})

describe('rule summaries', () => {
  it('summarises who can join', () => {
    expect(describeWhoCanJoin(rules)).toBe('Anyone · Any plan')
    expect(
      describeWhoCanJoin({ ...rules, gender: 'male', minAge: 21, allowedTiers: ['pro', 'plus'] }),
    ).toBe('Men · 21+ · Plus, Pro')
    expect(describeWhoCanJoin({ ...rules, minAge: 30, maxAge: 45 })).toBe(
      'Anyone · 30–45 · Any plan',
    )
  })

  it('summarises participation limits', () => {
    expect(describeParticipation(rules)).toBe('Plan length limit · No response limit')
    expect(describeParticipation({ ...rules, maxDurationMinutes: 10, maxResponses: 1 })).toBe(
      'Max 10 min · 1 response max',
    )
  })

  it('builds camp page pills only for rules that are set', () => {
    expect(campRulePills(rules)).toEqual([])
    expect(
      campRulePills({
        ...rules,
        gender: 'female',
        maxAge: 17,
        maxDurationMinutes: 3,
        maxResponses: 12,
        requiresTradeTags: true,
      }),
    ).toEqual(['Women', 'Up to 17', 'Max 3 min', '12 responses max', 'Need/offer tags'])
  })
})

describe('parseLimitInput', () => {
  it('accepts whole numbers and clamps them into range', () => {
    expect(parseLimitInput(' 12 ', 1, 180)).toBe(12)
    expect(parseLimitInput('0', 1, 180)).toBe(1)
    expect(parseLimitInput('999', 1, 180)).toBe(180)
  })

  it('rejects anything that is not a whole number', () => {
    expect(parseLimitInput('', 1, 180)).toBeNull()
    expect(parseLimitInput('1.5', 1, 180)).toBeNull()
    expect(parseLimitInput('-3', 1, 180)).toBeNull()
  })
})
