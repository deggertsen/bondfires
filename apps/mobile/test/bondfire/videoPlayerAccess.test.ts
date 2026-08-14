import { describe, expect, it, vi } from 'vitest'
import {
  safelyUseCurrentPlayer,
  safelyUsePlayer,
} from '../../../../packages/app/src/utils/videoPlayerAccess'

describe('video player access', () => {
  it('runs an operation for the current player', () => {
    const player = { playing: true }

    expect(safelyUseCurrentPlayer(player, player, (current) => current.playing)).toBe(true)
  })

  it('does not touch a player replaced after a source change', () => {
    const releasedPlayer = { playing: true }
    const currentPlayer = { playing: false }
    const operation = vi.fn()

    expect(safelyUseCurrentPlayer(currentPlayer, releasedPlayer, operation)).toBeUndefined()
    expect(operation).not.toHaveBeenCalled()
  })

  it('does not touch a player after unmount', () => {
    const player = { playing: true }
    const operation = vi.fn()

    expect(safelyUseCurrentPlayer(null, player, operation)).toBeUndefined()
    expect(operation).not.toHaveBeenCalled()
  })

  it('contains synchronous native shared-object failures', () => {
    const releasedPlayer = {
      get playing(): boolean {
        throw new Error('Cannot use shared object that was already released')
      },
    }

    expect(safelyUsePlayer(releasedPlayer, (player) => player.playing)).toBeUndefined()
  })
})
