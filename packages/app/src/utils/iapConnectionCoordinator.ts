interface IapConnectionAdapter {
  initConnection: () => Promise<boolean>
  endConnection: () => Promise<unknown>
}

/**
 * Serializes the native IAP connection lifecycle across catalog, purchase, and
 * restore consumers. Native billing clients do not tolerate overlapping
 * connect/disconnect calls, so every transition shares one operation queue.
 */
export function createIapConnectionCoordinator(adapter: IapConnectionAdapter) {
  let connected = false
  let consumerCount = 0
  let operationQueue: Promise<unknown> = Promise.resolve()
  let reconnectPromise: Promise<void> | null = null
  let disconnectPromise: Promise<void> | null = null

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function connect() {
    if (connected) return

    const initialized = await adapter.initConnection()
    if (!initialized) {
      throw new Error('The IAP connection did not become ready.')
    }
    connected = true
  }

  function ensureConnected() {
    return enqueue(connect)
  }

  function reconnect() {
    if (!reconnectPromise) {
      reconnectPromise = enqueue(async () => {
        if (connected) {
          try {
            await adapter.endConnection()
          } finally {
            connected = false
          }
        }
        await connect()
      }).finally(() => {
        reconnectPromise = null
      })
    }

    return reconnectPromise
  }

  function addConsumer() {
    consumerCount += 1
  }

  function removeConsumer(onDisconnect: () => void) {
    consumerCount = Math.max(0, consumerCount - 1)
    if (consumerCount > 0) return Promise.resolve()

    if (!disconnectPromise) {
      disconnectPromise = enqueue(async () => {
        // A new consumer may mount while this operation waits behind a
        // reconnect. In that case it still owns the shared connection.
        if (consumerCount > 0) return

        onDisconnect()
        try {
          await adapter.endConnection()
        } finally {
          connected = false
        }
      }).finally(() => {
        disconnectPromise = null
      })
    }

    return disconnectPromise
  }

  return {
    addConsumer,
    ensureConnected,
    reconnect,
    removeConsumer,
  }
}
