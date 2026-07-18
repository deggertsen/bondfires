import { describe, expect, it } from 'vitest'
import { getPersonalBondfireParticipantCap } from './personalBondfireAccess'

describe('personal Bondfire participant caps', () => {
  it('allows the sparker and one invitee on Plus', () => {
    expect(getPersonalBondfireParticipantCap('plus')).toBe(2)
  })

  it('allows the sparker and seven invitees on Premium and Pro', () => {
    expect(getPersonalBondfireParticipantCap('premium')).toBe(8)
    expect(getPersonalBondfireParticipantCap('pro')).toBe(8)
  })

  it('keeps the free fallback restrictive', () => {
    expect(getPersonalBondfireParticipantCap('free')).toBe(2)
  })
})
