/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { CURRENT_COMMUNITY_GUIDELINES_VERSION, CURRENT_TERMS_VERSION } from './contentSafety'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
async function setup() {
  const t = convexTest(schema, modules)
  const fixture = await t.run(async (ctx) => {
    const profile = {
      gender: 'other' as const,
      birthDate: '1990-01-01',
      forcedTier: 'pro' as const,
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
    }
    const owner = await ctx.db.insert('users', profile)
    const viewer = await ctx.db.insert('users', profile)
    const outsider = await ctx.db.insert('users', profile)
    const campId = await ctx.db.insert('camps', {
      slug: 'media-test',
      name: 'Media',
      purpose: 'Test',
      access: 'invite',
      status: 'active',
      ageBand: 'adult',
      ownerId: owner,
      rules: { access: {}, participation: { maxDurationMs: 10000 }, advisory: {} },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const members = []
    for (const userId of [owner, viewer])
      members.push(
        await ctx.db.insert('campMembers', {
          userId,
          campId,
          role: userId === owner ? 'owner' : 'member',
          status: 'active',
          muted: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      )
    return { owner, viewer, outsider, campId, members }
  })
  const owner = t.withIdentity({ subject: fixture.owner })
  const args = {
    localId: '00000000-0000-4000-8000-000000000001',
    isResponse: false,
    campId: fixture.campId,
  }
  const record = await owner.mutation(api.segmentMedia.begin, args)
  const receipt = (index: number, duration = 4, checksum = 'a'.repeat(64)) =>
    t.mutation(internal.segmentMedia.receipt, {
      recordingId: record.recordingId,
      userId: fixture.owner,
      index,
      duration,
      size: 1000,
      checksum,
    })
  return { t, fixture, owner, args, record, receipt }
}
beforeEach(() => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://lovely-malamute-525.convex.cloud')
  vi.stubEnv('INTERNAL_SEGMENT_MEDIA', '1')
})
afterEach(() => vi.unstubAllEnvs())
describe('internal recording lifecycle', () => {
  it('is idempotent, exposes only complete prefixes, and finalizes after all receipts', async () => {
    const { t, owner, args, record, receipt } = await setup()
    expect((await owner.mutation(api.segmentMedia.begin, args)).recordingId).toBe(
      record.recordingId,
    )
    expect(record.maxDuration).toBe(10)
    await expect(receipt(0)).rejects.toThrow()
    await receipt(-1, 0)
    await expect(receipt(1)).rejects.toThrow()
    await receipt(0)
    await receipt(0)
    await expect(receipt(0, 4, 'b'.repeat(64))).rejects.toThrow()
    await owner.mutation(api.segmentMedia.finish, {
      recordingId: record.recordingId,
      segmentCount: 3,
    })
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe(
      'waiting_for_upload',
    )
    await receipt(1)
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('live')
    await receipt(2, 2)
    expect((await t.run((ctx) => ctx.db.get(record.recordId)))?.videoStatus).toBe('ready')
    await expect(
      owner.mutation(api.segmentMedia.finish, { recordingId: record.recordingId, segmentCount: 4 }),
    ).rejects.toThrow()
    await expect(receipt(3, 1)).rejects.toThrow()
  })
  it('denies nonmembers, rechecks membership and deletion, and enforces ownership', async () => {
    const { t, fixture, record, receipt } = await setup()
    const read = (userId: typeof fixture.owner) =>
      t.query(internal.segmentMedia.authorize, {
        recordingId: record.recordingId,
        userId,
        operation: 'read',
      })
    await read(fixture.viewer)
    await expect(read(fixture.outsider)).rejects.toThrow()
    await expect(
      t
        .withIdentity({ subject: fixture.viewer })
        .mutation(api.segmentMedia.finish, { recordingId: record.recordingId, segmentCount: 1 }),
    ).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(fixture.members[1]))
    await expect(read(fixture.viewer)).rejects.toThrow()
    await t.run((ctx) => ctx.db.delete(record.recordId))
    await expect(receipt(-1, 0)).rejects.toThrow()
  })
  it('enforces the camp duration cap and rejects production execution', async () => {
    const { receipt, owner, args } = await setup()
    await receipt(-1, 0)
    await receipt(0, 6)
    await expect(receipt(1, 6)).rejects.toThrow()
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://ideal-akita-27.convex.cloud')
    await expect(owner.mutation(api.segmentMedia.begin, args)).rejects.toThrow(
      'Internal media is disabled',
    )
  })
})
