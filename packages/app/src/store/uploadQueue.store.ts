import { observable } from '@legendapp/state'
import { syncObservable } from '@legendapp/state/sync'

export interface UploadTask {
  id: string
  videoFilePath: string // Persistent path (copied from cache)
  bondfireId?: string // If responding to existing bondfire
  isResponse: boolean
  status: 'pending' | 'processing' | 'uploading' | 'completed' | 'failed'
  attemptCount: number
  lastAttemptAt?: number
  presignedUrls?: {
    // Cached after first fetch
    hdUrl: string
    sdUrl: string
    thumbnailUrl: string
    hdKey: string
    sdKey: string
    thumbnailKey: string
  }
  processedVideo?: {
    // Cached after processing
    hdUri: string
    sdUri: string
    thumbnailUri: string
    metadata: {
      width: number
      height: number
      durationMs: number
      size: number
    }
  }
  createdAt: number
}

interface UploadQueueState {
  tasks: UploadTask[]
}

export const uploadQueueStore$ = observable<UploadQueueState>({
  tasks: [],
})

// Sync with MMKV persistence
syncObservable(uploadQueueStore$, {
  persist: {
    name: 'bondfires-upload-queue',
  },
})

// Actions
export const uploadQueueActions = {
  addTask: (task: UploadTask) => {
    uploadQueueStore$.tasks.push(task)
  },

  updateTask: (taskId: string, updates: Partial<UploadTask>) => {
    const tasks = uploadQueueStore$.tasks.get()
    const index = tasks.findIndex((t) => t.id === taskId)
    if (index !== -1) {
      uploadQueueStore$.tasks[index].set({ ...tasks[index], ...updates })
    }
  },

  removeTask: (taskId: string) => {
    const tasks = uploadQueueStore$.tasks.get()
    const filtered = tasks.filter((t) => t.id !== taskId)
    uploadQueueStore$.tasks.set(filtered)
  },

  getPendingTasks: (): UploadTask[] => {
    const tasks = uploadQueueStore$.tasks.get()
    return tasks.filter(
      (t) => t.status === 'pending' || t.status === 'processing' || t.status === 'uploading',
    )
  },

  getTask: (taskId: string): UploadTask | undefined => {
    const tasks = uploadQueueStore$.tasks.get()
    return tasks.find((t) => t.id === taskId)
  },
}
