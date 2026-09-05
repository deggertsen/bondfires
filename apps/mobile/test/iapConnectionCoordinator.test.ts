import { describe, expect, it } from 'vitest'
import { createIapConnectionCoordinator } from '../../../packages/app/src/utils/iapConnectionCoordinator'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('IAP connection coordinator', () => {
  it('shares one initialization across concurrent consumers', async () => {
    let initializationCount = 0
    const coordinator = createIapConnectionCoordinator({
      initConnection: async () => {
        initializationCount += 1
        return true
      },
      endConnection: async () => true,
    })

    await Promise.all([
      coordinator.ensureConnected(),
      coordinator.ensureConnected(),
      coordinator.ensureConnected(),
    ])

    expect(initializationCount).toBe(1)
  })

  it('serializes final disconnect behind an in-flight reconnect', async () => {
    const firstEndStarted = deferred()
    const finishFirstEnd = deferred()
    const events: string[] = []
    let initializationCount = 0
    let endCount = 0
    const coordinator = createIapConnectionCoordinator({
      initConnection: async () => {
        initializationCount += 1
        events.push(`init:${initializationCount}`)
        return true
      },
      endConnection: async () => {
        endCount += 1
        events.push(`end:${endCount}:start`)
        if (endCount === 1) {
          firstEndStarted.resolve()
          await finishFirstEnd.promise
        }
        events.push(`end:${endCount}:finish`)
        return true
      },
    })

    coordinator.addConsumer()
    await coordinator.ensureConnected()
    const reconnectPromise = coordinator.reconnect()
    await firstEndStarted.promise
    const disconnectPromise = coordinator.removeConsumer(() => events.push('listeners:remove'))

    expect(endCount).toBe(1)
    finishFirstEnd.resolve()
    await Promise.all([reconnectPromise, disconnectPromise])

    expect(events).toEqual([
      'init:1',
      'end:1:start',
      'end:1:finish',
      'init:2',
      'listeners:remove',
      'end:2:start',
      'end:2:finish',
    ])
  })

  it('keeps the connection when a new consumer mounts before queued teardown', async () => {
    const finishReconnectEnd = deferred()
    const reconnectEndStarted = deferred()
    let endCount = 0
    let listenersRemoved = false
    const coordinator = createIapConnectionCoordinator({
      initConnection: async () => true,
      endConnection: async () => {
        endCount += 1
        if (endCount === 1) {
          reconnectEndStarted.resolve()
          await finishReconnectEnd.promise
        }
        return true
      },
    })

    coordinator.addConsumer()
    await coordinator.ensureConnected()
    const reconnectPromise = coordinator.reconnect()
    await reconnectEndStarted.promise
    const staleDisconnect = coordinator.removeConsumer(() => {
      listenersRemoved = true
    })
    coordinator.addConsumer()

    finishReconnectEnd.resolve()
    await Promise.all([reconnectPromise, staleDisconnect])

    expect(endCount).toBe(1)
    expect(listenersRemoved).toBe(false)

    await coordinator.removeConsumer(() => {
      listenersRemoved = true
    })
    expect(endCount).toBe(2)
    expect(listenersRemoved).toBe(true)
  })
})
