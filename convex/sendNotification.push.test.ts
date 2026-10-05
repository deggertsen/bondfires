/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { PushTokenOutcome } from './lib/pushProviders'
import * as providers from './lib/pushProviders'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const t = convexTest(schema, modules)
  const userId = await t.run((ctx) => ctx.db.insert('users', { gender: 'other' }))
  const client = t.withIdentity({ subject: userId })
  const tokenId = await client.mutation(api.notifications.registerDevice, {
    token: 'opaque-fcm-token',
    platform: 'android',
    tokenType: 'fcm',
  })
  if (!tokenId) throw new Error('Registration failed')
  const registration = await t.run((ctx) => ctx.db.get(tokenId))
  if (!registration) throw new Error('Missing registration')
  const begin = async () => {
    const tokens = await t.mutation(internal.notifications.beginPushDelivery, { userId })
    const token = tokens.find((token) => token._id === tokenId)
    if (!token) throw new Error('No eligible token')
    return async (outcome: PushTokenOutcome) =>
      t.mutation(internal.notifications.recordPushResults, {
        results: [
          {
            tokenId,
            registeredAt: token.updatedAt,
            attemptSequence: token.pushAttemptSequence,
            outcome,
          },
        ],
      })
  }
  const record = async (outcome: PushTokenOutcome) => (await begin())(outcome)

  return { t, client, userId, tokenId, registration, begin, record }
}

describe('durable push token health', () => {
  it('quarantines on the third consecutive ambiguous failure, retains the row, and recovers on registration', async () => {
    const { t, client, userId, tokenId, registration, record } = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    for (let n = 1; n <= 3; n++) {
      const result = await record('token_failure')
      expect(result.quarantinedCount).toBe(n === 3 ? 1 : 0)
      expect(await t.query(internal.notifications.getTokensForUser, { userId })).toHaveLength(
        n === 3 ? 0 : 1,
      )
    }
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toMatchObject({
      consecutiveTokenFailures: 3,
      quarantinedAt: expect.any(Number),
    })
    const staleResult = {
      tokenId,
      registeredAt: registration.updatedAt,
      attemptSequence: 3,
      outcome: 'invalid' as const,
    }
    await client.mutation(api.notifications.registerDevice, {
      token: 'opaque-fcm-token',
      platform: 'android',
      tokenType: 'fcm',
    })
    expect(await t.query(internal.notifications.getTokensForUser, { userId })).toHaveLength(1)
    expect((await t.run((ctx) => ctx.db.get(tokenId)))?.consecutiveTokenFailures).toBeUndefined()
    // A response from the old registration cannot delete the recovered row.
    await t.mutation(internal.notifications.recordPushResults, { results: [staleResult] })
    expect(await t.run((ctx) => ctx.db.get(tokenId))).not.toBeNull()
  })

  it.each(['success', 'other_failure'] as const)(
    '%s breaks the failure streak',
    async (outcome) => {
      const { t, tokenId, record } = await fixture()
      await record('token_failure')
      await record('token_failure')
      await record(outcome)
      await record('token_failure')
      const token = await t.run((ctx) => ctx.db.get(tokenId))
      expect(token?.consecutiveTokenFailures).toBe(1)
      expect(token?.quarantinedAt).toBeUndefined()
    },
  )

  it('never deletes or quarantines for repeated payload or infrastructure failures', async () => {
    const { t, tokenId, record } = await fixture()
    for (let n = 0; n < 6; n++) await record('other_failure')
    const token = await t.run((ctx) => ctx.db.get(tokenId))
    expect(token?.consecutiveTokenFailures).toBe(0)
    expect(token?.quarantinedAt).toBeUndefined()
  })

  it('ignores older failures after a newer success even when sends start in the same millisecond', async () => {
    const { t, tokenId, begin } = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const older = await begin()
    const newer = await begin()
    await newer('success')
    await older('invalid')
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toMatchObject({
      consecutiveTokenFailures: 0,
      lastPushResultSequence: 2,
    })
  })

  it('applies each delivery result only once', async () => {
    const { t, tokenId, begin } = await fixture()
    const result = await begin()
    for (let n = 0; n < 3; n++) await result('token_failure')
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toMatchObject({
      consecutiveTokenFailures: 1,
    })
    expect((await t.run((ctx) => ctx.db.get(tokenId)))?.quarantinedAt).toBeUndefined()
  })

  it.each(['success', 'other_failure'] as const)(
    'an in-flight %s cannot clear quarantine',
    async (outcome) => {
      const { t, tokenId, begin, record } = await fixture()
      await record('token_failure')
      await record('token_failure')
      const third = await begin()
      const inFlight = await begin()
      await third('token_failure')
      await inFlight(outcome)
      expect(await t.run((ctx) => ctx.db.get(tokenId))).toMatchObject({
        consecutiveTokenFailures: 3,
        quarantinedAt: expect.any(Number),
      })
    },
  )

  it('ignores an in-flight result after re-registration even when its sequence is reused', async () => {
    const { t, client, tokenId, begin } = await fixture()
    const oldResult = await begin()
    await client.mutation(api.notifications.registerDevice, {
      token: 'opaque-fcm-token',
      platform: 'android',
      tokenType: 'fcm',
    })
    const newResult = await begin()
    await oldResult('invalid')
    expect(await t.run((ctx) => ctx.db.get(tokenId))).not.toBeNull()
    await newResult('success')
  })

  it('deletes an explicitly invalid token immediately', async () => {
    const { t, tokenId, record } = await fixture()
    expect((await record('invalid')).deletedCount).toBe(1)
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toBeNull()
  })
})

describe('sendToUser cleanup', () => {
  it('prunes a mislabeled Expo token and sends only to the valid native registration', async () => {
    const { t, userId, tokenId, registration } = await fixture()
    const legacyId = await t.run((ctx) =>
      ctx.db.insert('deviceTokens', {
        userId,
        token: 'ExponentPushToken[legacy]',
        platform: 'android',
        tokenType: 'fcm',
        createdAt: 0,
        updatedAt: 0,
      }),
    )
    vi.spyOn(providers, 'getPushProviderConfig').mockReturnValue({
      apns: null,
      fcm: { projectId: 'test', clientEmail: 'test@example.com', privateKey: 'unused' },
    })
    const send = vi.spyOn(providers, 'sendFcmPushNotification').mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      invalidTokens: [],
      tokenResults: [{ token: registration.token, outcome: 'success' }],
    })
    const result = await t.action(internal.sendNotification.sendToUser, {
      userId,
      title: 'Hearth',
      body: 'Hello',
    })
    expect(send.mock.calls[0]?.[0]).toEqual([registration.token])
    expect(result).toMatchObject({ successCount: 1, failureCount: 1 })
    expect(await t.run((ctx) => ctx.db.get(legacyId))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(tokenId))).not.toBeNull()
  })

  it('cleans up a recipient with only unsupported tokens without provider credentials', async () => {
    const { t, userId, tokenId } = await fixture()
    await t.run((ctx) =>
      ctx.db.patch(tokenId, { token: 'ExpoPushToken[legacy]', tokenType: 'expo' }),
    )
    vi.spyOn(providers, 'getPushProviderConfig').mockReturnValue({ apns: null, fcm: null })
    const result = await t.action(internal.sendNotification.sendToUser, {
      userId,
      title: 'Hearth',
      body: 'Hello',
    })
    expect(result).toMatchObject({ successCount: 0, failureCount: 1 })
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toBeNull()
  })

  it('applies explicit provider invalidity to just the offending registration', async () => {
    const { t, userId, tokenId, registration } = await fixture()
    vi.spyOn(providers, 'getPushProviderConfig').mockReturnValue({
      apns: null,
      fcm: { projectId: 'test', clientEmail: 'test@example.com', privateKey: 'unused' },
    })
    vi.spyOn(providers, 'sendFcmPushNotification').mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      invalidTokens: [registration.token],
      tokenResults: [{ token: registration.token, outcome: 'invalid' }],
    })
    await t.action(internal.sendNotification.sendToUser, { userId, title: 'Hearth', body: 'Hello' })
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toBeNull()
  })

  it('persists ambiguous provider results and stops sending once quarantined', async () => {
    const { t, userId, registration } = await fixture()
    vi.spyOn(providers, 'getPushProviderConfig').mockReturnValue({
      apns: null,
      fcm: { projectId: 'test', clientEmail: 'test@example.com', privateKey: 'unused' },
    })
    const send = vi.spyOn(providers, 'sendFcmPushNotification').mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      invalidTokens: [],
      tokenResults: [{ token: registration.token, outcome: 'token_failure' }],
    })
    for (let n = 0; n < 4; n++)
      await t.action(internal.sendNotification.sendToUser, {
        userId,
        title: 'Hearth',
        body: 'Hello',
      })
    expect(send).toHaveBeenCalledTimes(3)
    expect(await t.query(internal.notifications.getTokensForUser, { userId })).toEqual([])
  })
})
