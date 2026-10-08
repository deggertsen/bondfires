/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import { internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import { purgeOld } from './clientLogs'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

describe('client log retention', () => {
  it('bounds every index range by expiration without scanning fresh or forensic logs', async () => {
    const indexes: Array<Array<[string, unknown]>> = []
    const take = vi.fn(async () => [])
    const query = vi.fn(() => ({
      withIndex: (name: string, range: (q: unknown) => unknown) => {
        expect(name).toBe('by_log_retention_level')
        const bounds: Array<[string, unknown]> = []
        indexes.push(bounds)
        const q = {
          eq: (field: string, value: unknown) => {
            bounds.push([field, value])
            return q
          },
          lt: (field: string, value: unknown) => {
            bounds.push([field, value])
            return q
          },
        }
        range(q)
        // No filter API: a post-read expiration filter would regress bandwidth.
        return { take }
      },
    }))
    const start = Date.now()
    await (
      purgeOld as unknown as {
        _handler: (ctx: MutationCtx, args: Record<string, never>) => Promise<unknown>
      }
    )._handler({ db: { query } } as unknown as MutationCtx, {})
    expect(indexes).toHaveLength(8)
    for (const bounds of indexes) {
      expect(bounds).toHaveLength(3)
      expect([undefined, 'standard']).toContain(bounds[0][1])
      expect(bounds[2][0]).toBe('createdAt')
      expect(bounds[2][1]).toBeGreaterThanOrEqual(start - 30 * 86400_000)
      expect(bounds[2][1]).toBeLessThanOrEqual(Date.now() - 30 * 86400_000)
    }
    expect(take).toHaveBeenCalledTimes(8)
    expect(take).toHaveBeenCalledWith(500)
  })

  it('keeps forensic and cutoff-boundary rows while capping deletes in each legacy/standard bucket', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const t = convexTest(schema, modules)
      await t.run(async (ctx) => {
        const row = {
          level: 'info' as const,
          event: 'test',
          message: 'test',
          platform: 'ios' as const,
        }
        for (const retention of [undefined, 'standard'] as const) {
          for (let i = 0; i < 501; i++)
            await ctx.db.insert('clientLogs', {
              ...row,
              retention,
              createdAt: now - 31 * 86400_000,
            })
          await ctx.db.insert('clientLogs', { ...row, retention, createdAt: now - 30 * 86400_000 })
          await ctx.db.insert('clientLogs', { ...row, retention, createdAt: now })
        }
        await ctx.db.insert('clientLogs', {
          ...row,
          retention: 'forensic',
          createdAt: now - 60 * 86400_000,
        })
      })
      expect((await t.mutation(internal.clientLogs.purgeOld, {})).deleted).toBe(1000)
      expect((await t.mutation(internal.clientLogs.purgeOld, {})).deleted).toBe(2)
      const remaining = await t.run((ctx) => ctx.db.query('clientLogs').collect())
      expect(remaining).toHaveLength(5)
      expect(remaining.filter((row) => row.retention === 'forensic')).toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
