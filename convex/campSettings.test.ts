/// <reference types="vite/client" />
import { convexTest, type TestConvex } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import {
  ALL_CAMP_TIERS,
  buildCampRules,
  buildVisibilityPatch,
  type CampRules,
  type CampRulesInput,
  PRIVATE_CAMP_DEFAULT_GUIDELINES,
  readCampRulesInput,
} from './lib/campSettingsPolicy'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const profile = {
  birthDate: '1990-01-01',
  gender: 'male' as const,
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
  acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
}

const openRules: CampRulesInput = {
  gender: 'any',
  minAge: null,
  maxAge: null,
  allowedTiers: [...ALL_CAMP_TIERS],
  visibilityMode: 'gate',
  maxDurationMinutes: null,
  maxResponses: null,
  requiresTradeTags: false,
  guidelines: [],
}

type Schema = typeof schema

function as(t: TestConvex<Schema>, userId: Id<'users'>) {
  return t.withIdentity({ subject: `${userId}|session` })
}

/** A Pro owner with a private camp, one member, and one pending request. */
async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const pro = await ctx.db.insert('users', { ...profile, displayName: 'Pro', forcedTier: 'pro' })
    const plus = await ctx.db.insert('users', {
      ...profile,
      displayName: 'Plus',
      forcedTier: 'plus',
    })
    const member = await ctx.db.insert('users', { ...profile, displayName: 'Member' })
    const requester = await ctx.db.insert('users', { ...profile, displayName: 'Requester' })
    await ctx.db.insert('campSlotTransactions', {
      userId: pro,
      type: 'monthly_grant',
      amount: 3,
      createdAt: now,
    })
    return { pro, plus, member, requester }
  })

  const campId = await as(t, ids.pro).mutation(api.camps.createPrivateCamp, {
    name: 'Thursday Guys',
  })
  await t.run(async (ctx) => {
    const now = Date.now()
    await ctx.db.insert('campMembers', {
      userId: ids.member,
      campId,
      role: 'member',
      status: 'active',
      muted: false,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.insert('campMembers', {
      userId: ids.requester,
      campId,
      role: 'member',
      status: 'pending',
      muted: false,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  })
  return { t, campId, ...ids }
}

async function membership(t: TestConvex<Schema>, campId: Id<'camps'>, userId: Id<'users'>) {
  return await t.run((ctx) =>
    ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .first(),
  )
}

describe('changeCampVisibility', () => {
  it('lets a Pro owner make a private camp public and drops the private-only seeds', async () => {
    const { t, campId, pro, requester } = await fixture()
    await as(t, pro).mutation(api.camps.changeCampVisibility, { campId, access: 'approval' })

    const camp = await t.run((ctx) => ctx.db.get(campId))
    expect(camp?.access).toBe('approval')
    expect(camp?.theme).toBeUndefined()
    expect(camp?.rules.advisory.guidelines).toEqual([])
    expect(camp?.rules.access.allowedTiers).toEqual({
      value: [...ALL_CAMP_TIERS],
      visibilityMode: 'gate',
    })
    // Approval keeps requests waiting for the owner.
    expect((await membership(t, campId, requester))?.status).toBe('pending')
  })

  it('approves pending requests when a camp becomes open', async () => {
    const { t, campId, pro, requester } = await fixture()
    const result = await as(t, pro).mutation(api.camps.changeCampVisibility, {
      campId,
      access: 'open',
    })
    expect(result.approvedRequests).toBe(1)
    expect((await membership(t, campId, requester))?.status).toBe('active')
    expect((await t.run((ctx) => ctx.db.get(campId)))?.activeMemberCount).toBe(3)
  })

  it('removes pending requests and keeps members when a camp goes private', async () => {
    const { t, campId, pro, member, requester } = await fixture()
    await as(t, pro).mutation(api.camps.changeCampVisibility, { campId, access: 'approval' })
    const result = await as(t, pro).mutation(api.camps.changeCampVisibility, {
      campId,
      access: 'invite',
    })
    expect(result.removedRequests).toBe(1)
    expect(await membership(t, campId, requester)).toBeNull()
    expect((await membership(t, campId, member))?.status).toBe('active')
    expect((await t.run((ctx) => ctx.db.get(campId)))?.access).toBe('invite')
  })

  it('requires Pro to go public, and only the owner can change it', async () => {
    const { t, campId, plus, member } = await fixture()
    const plusCamp = await as(t, plus).mutation(api.camps.createPrivateCamp, { name: 'Plus camp' })
    await expect(
      as(t, plus).mutation(api.camps.changeCampVisibility, { campId: plusCamp, access: 'open' }),
    ).rejects.toThrow('Public camps need Pro')
    await expect(
      as(t, member).mutation(api.camps.changeCampVisibility, { campId, access: 'open' }),
    ).rejects.toThrow('Only the camp owner')
  })

  it('closes the old raw access paths to owners', async () => {
    const { t, campId, plus } = await fixture()
    const plusCamp = await as(t, plus).mutation(api.camps.createPrivateCamp, { name: 'Plus camp' })
    await expect(
      as(t, plus).mutation(api.camps.updateSettings, { campId: plusCamp, access: 'open' }),
    ).rejects.toThrow('camp settings')
    await expect(
      as(t, plus).mutation(api.camps.setCampAccess, { campId: plusCamp, access: 'open' }),
    ).rejects.toThrow('Only admins')
    expect((await t.run((ctx) => ctx.db.get(campId)))?.access).toBe('invite')
  })
})

describe('updateCampRules and updateCampDetails', () => {
  it('writes owner rules, clears limits with null, and rejects bad ranges', async () => {
    const { t, campId, pro, member } = await fixture()
    const owner = as(t, pro)
    await owner.mutation(api.camps.updateCampRules, {
      campId,
      rules: {
        ...openRules,
        gender: 'male',
        minAge: 21,
        visibilityMode: 'hide',
        maxDurationMinutes: 12,
        maxResponses: 7,
        guidelines: ['  What’s said here stays here.  ', ''],
      },
    })
    let camp = await t.run((ctx) => ctx.db.get(campId))
    expect(camp?.rules.access.gender).toEqual({ value: 'male', visibilityMode: 'hide' })
    expect(camp?.rules.access.minAge).toEqual({ value: 21, visibilityMode: 'hide' })
    expect(camp?.rules.participation).toMatchObject({ maxDurationMs: 720_000, maxResponses: 7 })
    expect(camp?.rules.advisory.guidelines).toEqual(['What’s said here stays here.'])

    await owner.mutation(api.camps.updateCampRules, { campId, rules: openRules })
    camp = await t.run((ctx) => ctx.db.get(campId))
    expect(camp?.rules.participation.maxDurationMs).toBeUndefined()
    expect(camp?.rules.participation.maxResponses).toBeUndefined()
    expect(camp?.rules.access.minAge).toBeUndefined()

    await expect(
      owner.mutation(api.camps.updateCampRules, {
        campId,
        rules: { ...openRules, minAge: 40, maxAge: 30 },
      }),
    ).rejects.toThrow('Minimum age')
    await expect(
      owner.mutation(api.camps.updateCampRules, {
        campId,
        rules: { ...openRules, maxDurationMinutes: 181 },
      }),
    ).rejects.toThrow('Longest video')
    await expect(
      as(t, member).mutation(api.camps.updateCampRules, { campId, rules: openRules }),
    ).rejects.toThrow('Only the camp owner')
  })

  it('renames a private camp and keeps its display name in step', async () => {
    const { t, campId, pro } = await fixture()
    await as(t, pro).mutation(api.camps.updateCampDetails, {
      campId,
      name: '  Thursday Crew ',
      defaultPrompt: 'What’s on your mind this week?',
    })
    const camp = await t.run((ctx) => ctx.db.get(campId))
    expect(camp).toMatchObject({
      name: 'Thursday Crew',
      nameOverride: 'Thursday Crew',
      defaultPrompt: 'What’s on your mind this week?',
    })
    await expect(
      as(t, pro).mutation(api.camps.updateCampDetails, { campId, name: 'ab' }),
    ).rejects.toThrow('at least 3')
  })
})

describe('campSettingsPolicy', () => {
  const baseRules: CampRules = {
    access: {
      gender: { value: 'any', visibilityMode: 'hide' },
      allowedTiers: { value: ['plus', 'premium', 'pro'], visibilityMode: 'hide' },
      inviteOnly: { value: false, visibilityMode: 'gate' },
    },
    participation: { maxDurationMs: 900_000 },
    advisory: { guidelines: [...PRIVATE_CAMP_DEFAULT_GUIDELINES, 'Be kind.'] },
  }

  it('round-trips rules through the settings shape and keeps fields it does not edit', () => {
    const input = readCampRulesInput(baseRules)
    expect(input).toMatchObject({
      maxDurationMinutes: 15,
      maxResponses: null,
      visibilityMode: 'hide',
    })
    const rules = buildCampRules(baseRules, input, 'adult')
    expect(rules.access.inviteOnly).toEqual(baseRules.access.inviteOnly)
    expect(rules.access.allowedTiers).toEqual(baseRules.access.allowedTiers)
    expect(rules.participation.maxDurationMs).toBe(900_000)
  })

  it('bounds ages by the camp’s age band', () => {
    expect(() => buildCampRules(baseRules, { ...openRules, minAge: 16 }, 'adult')).toThrow(
      'between 18 and 120',
    )
    expect(buildCampRules(baseRules, { ...openRules, minAge: 16 }, 'teen').access.minAge).toEqual({
      value: 16,
      visibilityMode: 'gate',
    })
  })

  it('leaves owner-chosen tiers and guidelines alone when going public', () => {
    const custom: CampRules = {
      ...baseRules,
      access: { allowedTiers: { value: ['pro'], visibilityMode: 'gate' } },
    }
    const patch = buildVisibilityPatch(
      { access: 'invite', theme: 'Book club', rules: custom },
      'open',
    )
    expect(patch.theme).toBeUndefined()
    expect('theme' in patch).toBe(false)
    expect(patch.rules?.access.allowedTiers).toEqual({ value: ['pro'], visibilityMode: 'gate' })
    expect(patch.rules?.advisory.guidelines).toEqual(['Be kind.'])
  })

  it('changes only access when going private', () => {
    expect(
      buildVisibilityPatch({ access: 'open', theme: undefined, rules: baseRules }, 'invite'),
    ).toEqual({ access: 'invite' })
  })
})
