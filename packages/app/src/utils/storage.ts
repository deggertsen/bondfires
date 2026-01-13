import { configureObservableSync } from '@legendapp/state/sync'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'
import { createMMKV, type MMKV } from 'react-native-mmkv'

// MMKV instance - created once when first accessed
let storage: MMKV | null = null

function getStorage(): MMKV {
  if (!storage) {
    // MMKV v4 uses createMMKV() factory function instead of new MMKV()
    storage = createMMKV({ id: 'bondfires-storage' })
  }
  return storage
}

// Configure Legend State to use MMKV (v3 API)
export function configureStorage() {
  configureObservableSync({
    persist: {
      plugin: ObservablePersistMMKV,
    },
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
    // MMKV v4 uses remove() instead of delete()
    getStorage().remove(key)
  },
  clear: () => {
    getStorage().clearAll()
  },
}
