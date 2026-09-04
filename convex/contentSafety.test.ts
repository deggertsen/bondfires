import { describe, expect, it } from 'vitest'
import type { Doc } from './_generated/dataModel'
import {
  CURRENT_COMMUNITY_GUIDELINES_VERSION,
  CURRENT_TERMS_VERSION,
  hasCurrentLegalAcceptance,
  initialModerationStatus,
  isModeratedContentVisible,
} from './contentSafety'

function camp(access: Doc<'camps'>['access']): Doc<'camps'> {
  return { access } as Doc<'camps'>
}

describe('UGC publication policy', () => {
  it('holds publicly discoverable camp content for human review', () => {
    expect(initialModerationStatus(camp('open'), false)).toBe('pending_review')
    expect(initialModerationStatus(camp('approval'), false)).toBe('pending_review')
  })

  it('allows private and Hearth content for intended participants without a public queue', () => {
    expect(initialModerationStatus(camp('invite'), false)).toBe('approved')
    expect(initialModerationStatus(null, true)).toBe('approved')
  })

  it('shows held content only to its owner or an admin', () => {
    expect(isModeratedContentVisible('pending_review', { isOwner: false, isAdmin: false })).toBe(
      false,
    )
    expect(isModeratedContentVisible('pending_review', { isOwner: true, isAdmin: false })).toBe(
      true,
    )
    expect(isModeratedContentVisible('pending_review', { isOwner: false, isAdmin: true })).toBe(
      true,
    )
  })

  it('keeps removed content available only for owner appeal and admin review', () => {
    expect(isModeratedContentVisible('removed', { isOwner: false, isAdmin: false })).toBe(false)
    expect(isModeratedContentVisible('removed', { isOwner: true, isAdmin: false })).toBe(true)
    expect(isModeratedContentVisible('removed', { isOwner: false, isAdmin: true })).toBe(true)
  })
})

describe('versioned legal acceptance', () => {
  it('requires both current policy versions', () => {
    const accepted = {
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    } as Doc<'users'>
    expect(hasCurrentLegalAcceptance(accepted)).toBe(true)
    expect(
      hasCurrentLegalAcceptance({
        ...accepted,
        acceptedCommunityGuidelinesVersion: 'older',
      }),
    ).toBe(false)
  })
})
