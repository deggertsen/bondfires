import { describe, expect, it } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import {
  connectionMatchesPair,
  evaluateHearthParticipantGrant,
  evaluateHearthRelationship,
  familyPairKey,
} from './familyRelationships'

const teenId = 'teen-user' as Id<'users'>
const adultId = 'adult-user' as Id<'users'>
const otherAdultId = 'other-adult' as Id<'users'>
const connectionId = 'family-connection' as Id<'familyConnections'>

function connection(status: 'active' | 'revoked', firstUserId = teenId, secondUserId = adultId) {
  return { _id: connectionId, status, firstUserId, secondUserId } as Pick<
    Doc<'familyConnections'>,
    '_id' | 'status' | 'firstUserId' | 'secondUserId'
  >
}

describe('controlled family Hearth policy', () => {
  it('normalizes a pair independent of direction', () => {
    expect(familyPairKey(teenId, adultId)).toBe(familyPairKey(adultId, teenId))
    expect(connectionMatchesPair(connection('active'), adultId, teenId)).toBe(true)
  })

  it('allows peer Hearth participation without a family connection', () => {
    expect(evaluateHearthRelationship('teen', 'teen', null, teenId, teenId)).toEqual({
      allowed: true,
    })
    expect(evaluateHearthRelationship('adult', 'adult', null, adultId, otherAdultId)).toEqual({
      allowed: true,
    })
  })

  it('requires an active matching connection across the age boundary', () => {
    expect(evaluateHearthRelationship('teen', 'adult', null, teenId, adultId)).toEqual({
      allowed: false,
    })
    expect(
      evaluateHearthRelationship('teen', 'adult', connection('revoked'), teenId, adultId),
    ).toEqual({ allowed: false })
    expect(
      evaluateHearthRelationship(
        'teen',
        'adult',
        connection('active', teenId, otherAdultId),
        teenId,
        adultId,
      ),
    ).toEqual({ allowed: false })
    expect(
      evaluateHearthRelationship('teen', 'adult', connection('active'), teenId, adultId),
    ).toEqual({ allowed: true, familyConnectionId: connectionId })
  })

  it('fails closed when either account has no valid age band', () => {
    expect(
      evaluateHearthRelationship(null, 'adult', connection('active'), teenId, adultId),
    ).toEqual({ allowed: false })
  })

  it('keeps a family-bound participant tied to the exact active grant', () => {
    expect(
      evaluateHearthParticipantGrant(
        'teen',
        'adult',
        connection('active'),
        teenId,
        adultId,
        connectionId,
      ),
    ).toBe(true)
    expect(
      evaluateHearthParticipantGrant(
        'adult',
        'adult',
        connection('revoked'),
        teenId,
        adultId,
        connectionId,
      ),
    ).toBe(false)
    expect(evaluateHearthParticipantGrant('adult', 'adult', null, teenId, adultId)).toBe(true)
  })
})
