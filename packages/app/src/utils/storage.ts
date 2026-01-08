import { MMKV } from 'react-native-mmkv'
import { configurePersistable } from '@legendapp/state/persist'
import { ObservablePersistMMKV } from '@legendapp/state/persist-plugins/mmkv'

// Create MMKV instance
export const storage = new MMKV({
  id: 'bondfires-storage',
})

// Configure Legend State to use MMKV
export function configureStorage() {
  // Set up the MMKV plugin with our storage instance
  configurePersistable({
    pluginLocal: ObservablePersistMMKV,
    localOptions: {
      mmkv: storage,
    },
  })
}

// Helper functions for direct MMKV access if needed
export const mmkvStorage = {
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  getItem: (key: string): string | null => {
    return storage.getString(key) ?? null
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => {
    storage.clearAll()
  },
}

