import { configureObservablePersistence } from '@legendapp/state/persist'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'

// Interface matching react-native-mmkv's MMKV class
interface MMKVStorage {
  set(key: string, value: string | number | boolean): void
  getString(key: string): string | undefined
  getNumber(key: string): number | undefined
  getBoolean(key: string): boolean | undefined
  delete(key: string): void
  clearAll(): void
  contains(key: string): boolean
  getAllKeys(): string[]
}

// MMKV instance will be created lazily when running in React Native
let storage: MMKVStorage | null = null

function getStorage(): MMKVStorage {
  if (!storage) {
    // Dynamic require to avoid issues during type checking
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as {
      MMKV: new (config: { id: string }) => MMKVStorage
    }
    storage = new MMKV({ id: 'bondfires-storage' })
  }
  return storage
}

// Configure Legend State to use MMKV
export function configureStorage() {
  configureObservablePersistence({
    pluginLocal: ObservablePersistMMKV,
  })
}

// Helper functions for direct MMKV access if needed
export const mmkvStorage = {
  setItem: (key: string, value: string) => {
    getStorage().set(key, value)
  },
  getItem: (key: string): string | null => {
    return getStorage().getString(key) ?? null
  },
  removeItem: (key: string) => {
    getStorage().delete(key)
  },
  clear: () => {
    getStorage().clearAll()
  },
}
