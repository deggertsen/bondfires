/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { auth } from './auth'
import { appleProfile, createOrUpdateAuthUser, googleProfile } from './lib/authProfiles'
import { authRedirect, MOBILE_AUTH_CALLBACK, registrationProfile } from './lib/registrationPolicy'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const details = {
  firstName: 'Test',
  lastName: 'Member',
  gender: 'other' as const,
  birthDate: '2000-01-01',
  acceptedLegal: true,
}
const google = { id: 'google', name: 'Google', type: 'oidc' as const }
const apple = { id: 'apple', name: 'Apple', type: 'oidc' as const }
const profile = {
  email: 'member@example.com',
  emailVerified: true,
  firstName: 'Test',
  lastName: 'Member',
}

function setup() {
  return convexTest(schema, modules)
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('social registration', () => {
  it('keeps pending accounts out of queries, mutations and actions until full completion', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'oauth',
        provider: google,
        profile,
      }),
    )
    const user = t.withIdentity({ subject: `${id}|session` })
    expect(await user.query(api.users.current)).toMatchObject({ registrationPending: true })
    expect(await user.query(api.registration.status)).toMatchObject({
      pending: true,
      firstName: 'Test',
    })
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBeNull()
    expect(await user.action((ctx) => auth.getUserId(ctx))).toBeNull()
    await expect(user.mutation(api.users.updateProfile, { gender: 'male' })).rejects.toThrow(
      'Not authenticated',
    )
    await expect(user.mutation(api.legal.acceptCurrent, {})).rejects.toThrow('Not authenticated')
    await expect(
      user.mutation(api.registration.complete, { ...details, acceptedLegal: false }),
    ).rejects.toThrow('accept')
    await expect(
      user.mutation(api.registration.complete, { ...details, birthDate: '2020-01-01' }),
    ).rejects.toThrow('13')
    await user.mutation(api.registration.complete, details)
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBe(id)
    expect(await user.action((ctx) => auth.getUserId(ctx))).toBe(id)
    expect(await user.query(api.registration.status)).toMatchObject({
      pending: false,
      acceptedLegal: true,
      gender: 'other',
    })
    // A retry (or an attempted age-band change) never replaces the original DOB.
    await user.mutation(api.registration.complete, { ...details, birthDate: '2010-01-01' })
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ birthDate: '2000-01-01' })
  })

  it('links a verified email without changing profile, birthday, legal or moderation state', async () => {
    const t = setup()
    const existing = {
      ...registrationProfile(details),
      email: profile.email,
      emailVerificationTime: 1,
      firstName: 'Edited',
      moderationStatus: 'suspended' as const,
    }
    const id = await t.run((ctx) => ctx.db.insert('users', existing))
    const linked = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'oauth',
        provider: google,
        profile,
      }),
    )
    expect(linked).toBe(id)
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject(existing)
  })

  it('does not link social login to an unverified password signup or a different relay email', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      ctx.db.insert('users', { ...registrationProfile(details), email: profile.email }),
    )
    const other = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'oauth',
        provider: google,
        profile,
      }),
    )
    expect(other).not.toBe(id)
    const relay = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'oauth',
        provider: apple,
        profile: {
          ...profile,
          email: 'relay@privaterelay.appleid.com',
          appleRefreshToken: 'private-token',
        },
      }),
    )
    expect(relay).not.toBe(other)
    expect(
      await t.withIdentity({ subject: `${relay}|session` }).query(api.users.current),
    ).not.toHaveProperty('appleRefreshToken')
  })

  it('preserves first-authorization Apple names on subsequent logins', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'oauth',
        provider: apple,
        profile: { ...profile, appleRefreshToken: 'private-token' },
      }),
    )
    await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: id,
        type: 'oauth',
        provider: apple,
        profile: { email: profile.email, emailVerified: true },
      }),
    )
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      firstName: 'Test',
      lastName: 'Member',
      registrationPending: true,
    })
  })

  it('preserves password signup and emailed verification without trusting client verification flags', async () => {
    const t = setup()
    const password = { id: 'password', type: 'credentials' as const, authorize: async () => null }
    const id = await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: null,
        type: 'credentials',
        provider: password,
        profile: { email: profile.email, ...registrationProfile(details) },
      }),
    )
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      registrationPending: false,
      birthDate: details.birthDate,
    })
    expect((await t.run((ctx) => ctx.db.get(id)))?.emailVerificationTime).toBeUndefined()
    await t.run((ctx) =>
      createOrUpdateAuthUser(ctx, {
        existingUserId: id,
        type: 'verification',
        provider: password,
        profile: { email: profile.email, emailVerified: true },
      }),
    )
    expect((await t.run((ctx) => ctx.db.get(id)))?.emailVerificationTime).toBeTypeOf('number')
  })

  it('blocks deleted accounts even with a still-valid session and rejects anonymous completion', async () => {
    const t = setup()
    await expect(t.mutation(api.registration.complete, details)).rejects.toThrow(
      'Not authenticated',
    )
    const id = await t.run((ctx) =>
      ctx.db.insert('users', {
        ...registrationProfile(details),
        accountDeletionStatus: 'requested',
      }),
    )
    const user = t.withIdentity({ subject: `${id}|session` })
    expect(await user.query(api.registration.status)).toBeNull()
    expect(await user.action((ctx) => auth.getUserId(ctx))).toBeNull()
    await expect(user.mutation(api.registration.complete, details)).rejects.toThrow(
      'Not authenticated',
    )
    await expect(
      t.run((ctx) =>
        createOrUpdateAuthUser(ctx, {
          existingUserId: id,
          type: 'oauth',
          provider: google,
          profile,
        }),
      ),
    ).rejects.toThrow('deleted')
  })

  it('revokes Apple before erasing credentials and retains them for retry on failure', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      ctx.db.insert('users', {
        gender: 'other',
        registrationPending: true,
        accountDeletionStatus: 'requested',
      }),
    )
    const credential = await t.run((ctx) =>
      ctx.db.insert('oauthCredentials', { userId: id, refreshToken: 'secret-token' }),
    )
    vi.stubEnv('AUTH_APPLE_ID', 'test-id')
    vi.stubEnv('AUTH_APPLE_SECRET', 'test-secret')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      t.action(internal.oauthCredentials.revokeForDeletion, { userId: id }),
    ).rejects.toThrow('503')
    expect(await t.run((ctx) => ctx.db.get(credential))).not.toBeNull()
    await t.action(internal.oauthCredentials.revokeForDeletion, { userId: id })
    expect(await t.run((ctx) => ctx.db.get(credential))).toBeNull()
    await t.action(internal.oauthCredentials.revokeForDeletion, { userId: id })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].body.get('token')).toBe('secret-token')
  })
})

describe('registration validation and OAuth mappings', () => {
  it('enforces complete names, gender, legal and the conservative age boundary', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    for (const patch of [
      { firstName: '' },
      { lastName: '' },
      { gender: undefined },
      { acceptedLegal: false },
      { birthDate: '2013-09-20' },
      { birthDate: '2012-02-30' },
    ]) {
      expect(() => registrationProfile({ ...details, ...patch }, now)).toThrow()
    }
    expect(registrationProfile({ ...details, birthDate: '2013-09-19' }, now)).toMatchObject({
      registrationPending: false,
    })
  })
  it('rejects unverified identities and maps only supported profile fields', () => {
    expect(() =>
      googleProfile({ sub: 'g', email: 'a@example.com', email_verified: false }),
    ).toThrow('verified')
    expect(() =>
      appleProfile({ sub: 'a', email: 'a@example.com', email_verified: 'false' }, {}),
    ).toThrow('verified')
    expect(
      googleProfile({ sub: 'g', email: 'old-owner@example.com', email_verified: true })
        .emailVerified,
    ).toBe(false)
    expect(
      googleProfile({ sub: 'g', email: 'member@gmail.com', email_verified: true }).emailVerified,
    ).toBe(true)
    expect(
      googleProfile({
        sub: 'g',
        email: 'member@work.example',
        email_verified: true,
        hd: 'work.example',
      }).emailVerified,
    ).toBe(true)
    expect(
      appleProfile(
        {
          sub: 'a',
          email: 'a@example.com',
          email_verified: 'true',
          user: { name: { firstName: 'Test' } },
        },
        { refresh_token: 'private' },
      ),
    ).toMatchObject({ id: 'a', firstName: 'Test', appleRefreshToken: 'private' })
  })
  it('allows only the exact app callback, without open redirects or URL credentials', () => {
    expect(authRedirect(MOBILE_AUTH_CALLBACK)).toBe(MOBILE_AUTH_CALLBACK)
    for (const url of [
      'https://evil.example',
      'bondfires://auth-callback.evil',
      'bondfires://auth-callback?redirect=https://evil.example',
      'bondfires://evil@auth-callback',
    ]) {
      expect(() => authRedirect(url)).toThrow()
    }
  })
})
