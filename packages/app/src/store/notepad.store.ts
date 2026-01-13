import { observable } from '@legendapp/state'
import { syncObservable } from '@legendapp/state/sync'

// Notepad content state
export const notepadStore$ = observable<{
  content: string
}>({
  content: '',
})

// Sync with MMKV persistence
syncObservable(notepadStore$, {
  persist: {
    name: 'bondfires-notepad',
  },
})

// Actions
export const notepadActions = {
  setContent: (content: string) => {
    notepadStore$.content.set(content)
  },

  clearContent: () => {
    notepadStore$.content.set('')
  },
}
