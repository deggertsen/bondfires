/// <reference types="vite/client" />
import { anyApi } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { auth } from './auth'
import { appleProfile, createOrUpdateAuthUser, googleProfile } from './lib/authProfiles'
import {
  authRedirect,
  canUseApp,
  deviceAgeRecheckPatch,
  MOBILE_AUTH_CALLBACK,
  registrationAgeFields,
  registrationProfile,
} from './lib/registrationPolicy'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const details = {
  firstName: 'Test',
  lastName: 'Member',
  gender: 'other' as const,
  birthMonth: '2000-01',
  acceptedLegal: true,
}
const adultDevice = {
  source: 'apple_declared_age_range' as const,
  lowerBound: 18,
  upperBound: null,
}
const teenDevice = { source: 'play_age_signals' as const, lowerBound: 13, upperBound: 15 }
const childDevice = { source: 'play_age_signals' as const, lowerBound: 0, upperBound: 12 }
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
      user.mutation(api.registration.complete, { ...details, birthMonth: '2020-01' }),
    ).rejects.toThrow('13')
    await user.mutation(api.registration.complete, details)
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBe(id)
    expect(await user.action((ctx) => auth.getUserId(ctx))).toBe(id)
    expect(await user.query(api.registration.status)).toMatchObject({
      pending: false,
      acceptedLegal: true,
      gender: 'other',
    })
    // A retry (or an attempted age-band change) never replaces the original age data.
    await user.mutation(api.registration.complete, { ...details, birthMonth: '2010-01' })
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      birthMonth: '2000-01',
      ageSource: 'birth_month',
    })
    expect((await t.run((ctx) => ctx.db.get(id)))?.birthDate).toBeUndefined()
  })

  it('stores only the device source and band when the phone answers, never a fake date', async () => {
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
    await user.mutation(api.registration.complete, {
      ...details,
      birthMonth: undefined,
      deviceAgeRange: teenDevice,
    })
    const stored = await t.run((ctx) => ctx.db.get(id))
    expect(stored).toMatchObject({
      registrationPending: false,
      ageSource: 'play_age_signals',
      deviceAgeBand: 'teen',
    })
    expect(stored?.deviceAgeCheckedAt).toBeTypeOf('number')
    expect(stored?.birthDate).toBeUndefined()
    expect(stored?.birthMonth).toBeUndefined()
    expect(await user.query(api.users.current)).toMatchObject({
      ageBand: 'teen',
      ageBlocked: false,
    })
    expect(await user.query(api.users.current)).not.toHaveProperty('deviceAgeBand')
    expect(await user.query(api.users.current)).not.toHaveProperty('birthMonth')
  })

  it('rejects an under-13 device range even when the month says adult, and rejects full dates', async () => {
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
    await expect(
      user.mutation(api.registration.complete, { ...details, deviceAgeRange: childDevice }),
    ).rejects.toThrow('13')
    await expect(
      user.mutation(api.registration.complete, { ...details, birthMonth: '2000-01-01' }),
    ).rejects.toThrow('YYYY-MM')
    // The old full-date argument is not accepted at all.
    await expect(
      user.mutation(anyApi.registration.complete, { ...details, birthDate: '2000-01-01' }),
    ).rejects.toThrow()
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ registrationPending: true })
    await user.mutation(api.registration.complete, details)
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ birthMonth: '2000-01' })
  })

  it('re-checks the device after signup without touching a legacy birth date', async () => {
    const t = setup()
    const legacy = await t.run((ctx) =>
      ctx.db.insert('users', {
        ...registrationProfile(details),
        birthMonth: undefined,
        ageSource: 'birth_date',
        birthDate: '2010-06-15',
      }),
    )
    const legacyUser = t.withIdentity({ subject: `${legacy}|session` })
    expect(await legacyUser.query(api.registration.status)).toMatchObject({
      deviceAgeRecheck: false,
    })
    expect(
      await legacyUser.mutation(api.registration.recheckDeviceAge, {
        expectedUserId: legacy,
        deviceAgeRange: adultDevice,
      }),
    ).toEqual({ status: 'skipped' })
    expect(await t.run((ctx) => ctx.db.get(legacy))).toMatchObject({
      birthDate: '2010-06-15',
      ageSource: 'birth_date',
    })
    expect((await t.run((ctx) => ctx.db.get(legacy)))?.deviceAgeBand).toBeUndefined()

    // A month-sourced teen becomes an adult from the phone alone.
    const month = await t.run((ctx) =>
      ctx.db.insert('users', { ...registrationProfile({ ...details, birthMonth: '2008-01' }) }),
    )
    const monthUser = t.withIdentity({ subject: `${month}|session` })
    expect(await monthUser.query(api.registration.status)).toMatchObject({
      deviceAgeRecheck: true,
      ageSource: 'birth_month',
    })
    expect(
      await monthUser.mutation(api.registration.recheckDeviceAge, {
        expectedUserId: month,
        deviceAgeRange: adultDevice,
      }),
    ).toEqual({ status: 'updated' })
    const promoted = await t.run((ctx) => ctx.db.get(month))
    expect(promoted).toMatchObject({
      ageSource: 'apple_declared_age_range',
      deviceAgeBand: 'adult',
    })
    expect(promoted?.birthMonth).toBeUndefined()
    expect(promoted?.birthDate).toBeUndefined()
    // A later empty signal keeps the last eligible band.
    expect(
      await monthUser.mutation(api.registration.recheckDeviceAge, {
        expectedUserId: month,
        deviceAgeRange: { source: 'apple_declared_age_range' },
      }),
    ).toEqual({ status: 'skipped' })
    expect(await t.run((ctx) => ctx.db.get(month))).toMatchObject({ deviceAgeBand: 'adult' })
  })

  it('blocks access when a later device range is under 13 and a month cannot clear it', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      ctx.db.insert('users', {
        ...registrationProfile({ ...details, deviceAgeRange: teenDevice }),
      }),
    )
    const user = t.withIdentity({ subject: `${id}|session` })
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBe(id)
    expect(
      await user.mutation(api.registration.recheckDeviceAge, {
        expectedUserId: id,
        deviceAgeRange: childDevice,
      }),
    ).toEqual({ status: 'blocked' })
    const blocked = await t.run((ctx) => ctx.db.get(id))
    expect(blocked?.ageBlockedAt).toBeTypeOf('number')
    // The prior band is kept (unusable while blocked) so a later range can't downgrade it.
    expect(blocked?.deviceAgeBand).toBe('teen')
    expect(canUseApp(blocked)).toBe(false)
    // Blocked, but the account still exists and never re-enters registration.
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBeNull()
    expect(await user.query(api.users.current)).toMatchObject({
      registrationPending: false,
      ageBlocked: true,
    })
    expect(await user.query(api.registration.status)).toMatchObject({
      pending: false,
      ageBlocked: true,
      deviceAgeRecheck: true,
      userId: id,
    })
    await expect(user.mutation(api.users.updateProfile, { gender: 'male' })).rejects.toThrow(
      'Not authenticated',
    )
    // Completion is one-time, so a typed month cannot override the phone.
    await user.mutation(api.registration.complete, { ...details, birthMonth: '2000-01' })
    const stillBlocked = await t.run((ctx) => ctx.db.get(id))
    expect(stillBlocked?.ageBlockedAt).toBeTypeOf('number')
    expect(stillBlocked?.birthMonth).toBeUndefined()
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBeNull()
    // The same blocked session can recover without entering registration.
    await user.mutation(api.registration.recheckDeviceAge, {
      expectedUserId: id,
      deviceAgeRange: teenDevice,
    })
    expect(await user.query(api.users.current)).toMatchObject({
      ageBlocked: false,
      ageBand: 'teen',
    })
    expect(await user.run((ctx) => auth.getUserId(ctx))).toBe(id)
  })

  it('rejects a device response requested by a different account', async () => {
    const t = setup()
    const first = await t.run((ctx) => ctx.db.insert('users', registrationProfile(details)))
    const second = await t.run((ctx) => ctx.db.insert('users', registrationProfile(details)))
    const user = t.withIdentity({ subject: `${second}|session` })
    await expect(
      user.mutation(api.registration.recheckDeviceAge, {
        expectedUserId: first,
        deviceAgeRange: childDevice,
      }),
    ).rejects.toThrow('Account changed')
    expect(await user.query(api.users.current)).toMatchObject({
      ageBlocked: false,
      ageBand: 'adult',
    })
    expect(await user.query(api.users.current)).not.toHaveProperty('age')
    expect(await t.run((ctx) => ctx.db.get(second))).toMatchObject({
      birthMonth: details.birthMonth,
    })
  })

  it('never moves an adult account into the teen band, even through a block', async () => {
    const t = setup()
    const deviceAdult = await t.run((ctx) =>
      ctx.db.insert('users', {
        ...registrationProfile({ ...details, deviceAgeRange: adultDevice }),
      }),
    )
    const monthAdult = await t.run((ctx) => ctx.db.insert('users', registrationProfile(details)))
    for (const id of [deviceAdult, monthAdult]) {
      const user = t.withIdentity({ subject: `${id}|session` })
      const recheck = (deviceAgeRange: typeof adultDevice | typeof teenDevice) =>
        user.mutation(api.registration.recheckDeviceAge, { expectedUserId: id, deviceAgeRange })
      expect(await recheck(teenDevice)).toEqual({ status: 'skipped' })
      expect(await user.query(api.users.current)).toMatchObject({ ageBand: 'adult' })
      // Blocked, then a teen range: the block stays rather than becoming a teen account.
      expect(await recheck(childDevice)).toEqual({ status: 'blocked' })
      expect(await recheck(teenDevice)).toEqual({ status: 'skipped' })
      expect(await user.query(api.users.current)).toMatchObject({ ageBlocked: true })
      // An adult range restores the adult account.
      expect(await recheck(adultDevice)).toEqual({ status: 'updated' })
      expect(await user.query(api.users.current)).toMatchObject({
        ageBand: 'adult',
        ageBlocked: false,
      })
    }
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
      birthMonth: details.birthMonth,
      ageSource: 'birth_month',
    })
    expect((await t.run((ctx) => ctx.db.get(id)))?.birthDate).toBeUndefined()
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
      { birthMonth: '2013-09' },
      { birthMonth: '2012-13' },
      { birthMonth: '2000-01-01' },
      { birthMonth: undefined },
      { birthMonth: undefined, birthDate: '2000-01-01' },
      { birthDate: '2000-01-01' },
    ]) {
      expect(() => registrationProfile({ ...details, ...patch }, now)).toThrow()
    }
    // Born July 2013: 13 only once July 2026 is over (end-of-month, prior UTC day).
    expect(registrationProfile({ ...details, birthMonth: '2013-07' }, now)).toMatchObject({
      registrationPending: false,
      birthMonth: '2013-07',
      ageSource: 'birth_month',
    })
    expect(registrationProfile({ ...details, birthMonth: '2013-07' }, now)).not.toHaveProperty(
      'birthDate',
    )
  })
  it('lets a device range decide alone and rejects under-13 ranges regardless of the month', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    expect(
      registrationAgeFields({ deviceAgeRange: adultDevice, birthMonth: '2015-01' }, now),
    ).toEqual({
      ageSource: 'apple_declared_age_range',
      deviceAgeBand: 'adult',
      deviceAgeCheckedAt: now.getTime(),
    })
    expect(registrationAgeFields({ deviceAgeRange: teenDevice }, now)).toMatchObject({
      ageSource: 'play_age_signals',
      deviceAgeBand: 'teen',
    })
    expect(() =>
      registrationAgeFields({ deviceAgeRange: childDevice, birthMonth: '2000-01' }, now),
    ).toThrow('13')
    expect(() =>
      registrationAgeFields(
        { deviceAgeRange: { source: 'play_age_signals', lowerBound: 10, upperBound: 15 } },
        now,
      ),
    ).toThrow('13')
    // No usable device range: fall back to the month.
    expect(
      registrationAgeFields(
        { deviceAgeRange: { source: 'play_age_signals' }, birthMonth: '2000-01' },
        now,
      ),
    ).toEqual({ ageSource: 'birth_month', birthMonth: '2000-01' })
    expect(() =>
      registrationAgeFields({ deviceAgeRange: { source: 'play_age_signals' } }, now),
    ).toThrow('YYYY-MM')
    expect(() => registrationAgeFields({ deviceAgeRange: { source: 'nope' } }, now)).toThrow()
    expect(() =>
      registrationAgeFields(
        { deviceAgeRange: { source: 'play_age_signals', lowerBound: '18' } },
        now,
      ),
    ).toThrow()
  })
  it('re-check never writes a birth date and never reads a month', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    expect(deviceAgeRecheckPatch({ birthDate: '2000-01-01' }, childDevice, now)).toEqual({
      status: 'skipped',
      patch: {},
    })
    expect(deviceAgeRecheckPatch({ registrationPending: true }, adultDevice, now)).toEqual({
      status: 'skipped',
      patch: {},
    })
    const updated = deviceAgeRecheckPatch({}, adultDevice, now)
    expect(updated.status).toBe('updated')
    expect(updated.patch).toMatchObject({ deviceAgeBand: 'adult', ageBlockedAt: undefined })
    expect(updated.patch).not.toHaveProperty('birthDate')
    const blocked = deviceAgeRecheckPatch({}, childDevice, now)
    expect(blocked.status).toBe('blocked')
    expect(blocked.patch).toMatchObject({ ageBlockedAt: now.getTime() })
    expect(blocked.patch).not.toHaveProperty('birthDate')
    expect(blocked.patch).not.toHaveProperty('deviceAgeBand')
    expect(blocked.patch).not.toHaveProperty('birthMonth')
    // Already blocked: nothing to change.
    expect(deviceAgeRecheckPatch({ ageBlockedAt: 1 }, childDevice, now).status).toBe('skipped')
    // One-way: teen graduates to adult, adult never becomes teen.
    const teen = { ageSource: 'play_age_signals', deviceAgeBand: 'teen' } as const
    const adult = { ageSource: 'apple_declared_age_range', deviceAgeBand: 'adult' } as const
    expect(deviceAgeRecheckPatch(teen, adultDevice, now).patch).toMatchObject({
      deviceAgeBand: 'adult',
    })
    expect(deviceAgeRecheckPatch(adult, teenDevice, now).status).toBe('skipped')
    expect(
      deviceAgeRecheckPatch({ ageSource: 'birth_month', birthMonth: '2000-01' }, teenDevice, now)
        .status,
    ).toBe('skipped')
    expect(deviceAgeRecheckPatch({ ...adult, ageBlockedAt: 1 }, teenDevice, now).status).toBe(
      'skipped',
    )
    // A month-sourced teen whose phone also says teen moves to the device source.
    expect(
      deviceAgeRecheckPatch({ ageSource: 'birth_month', birthMonth: '2012-01' }, teenDevice, now)
        .patch,
    ).toMatchObject({ ageSource: 'play_age_signals', deviceAgeBand: 'teen', birthMonth: undefined })
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
