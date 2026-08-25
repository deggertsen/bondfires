import { describe, expect, it, vi } from 'vitest'
import { openStoreLink } from '../../../packages/app/src/utils/storeLink'

describe('openStoreLink', () => {
  it('opens the requested URL', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)

    await expect(openStoreLink('https://example.com/store', openUrl)).resolves.toEqual({
      opened: true,
    })
    expect(openUrl).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledWith('https://example.com/store')
  })

  it('converts a native linking rejection into a handled failure result', async () => {
    const failure = new Error('Unable to open URL')
    const openUrl = vi.fn().mockRejectedValue(failure)

    await expect(openStoreLink('https://example.com/store', openUrl)).resolves.toEqual({
      opened: false,
      error: failure,
    })
  })
})
