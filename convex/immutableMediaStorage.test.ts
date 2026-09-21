import { describe, expect, it, vi } from 'vitest'
import { putImmutable } from '../packages/media/src/immutableStorage'

describe('immutable import retries', () => {
  it('does not rewrite a completed upload and rejects conflicting bytes', async () => {
    const write = vi.fn()
    expect(await putImmutable('a', async () => 'a', write)).toBe(true)
    expect(await putImmutable('b', async () => 'a', write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('accepts a concurrent identical upload even when R2 throws its precondition failure', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('a')
    expect(
      await putImmutable('a', read, async () => {
        throw Error('Precondition failed')
      }),
    ).toBe(true)
  })
  it('propagates a storage failure without claiming success', async () => {
    await expect(
      putImmutable(
        'a',
        async () => null,
        async () => {
          throw Error('Unavailable')
        },
      ),
    ).rejects.toThrow('Unavailable')
  })
  it('checks the stored checksum after a new write', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('a')
    const write = vi.fn().mockResolvedValue(undefined)
    expect(await putImmutable('a', read, write)).toBe(true)
    expect(write).toHaveBeenCalledOnce()
  })
})
