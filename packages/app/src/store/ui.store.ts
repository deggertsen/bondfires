import { observable } from '@legendapp/state'

// Transient UI state (not persisted)
export interface UIState {
  // Loading states
  isLoading: boolean
  loadingMessage: string | null

  // Modal states
  activeModal: string | null
  modalData: Record<string, unknown> | null

  // Video player state
  currentVideoId: string | null
  isVideoPlaying: boolean
  videoProgress: number

  // Toast/notifications
  toast: {
    visible: boolean
    message: string
    type: 'success' | 'error' | 'info'
  } | null

  // Network state
  isOnline: boolean

  // Keyboard state
  keyboardVisible: boolean
}

const defaultUIState: UIState = {
  isLoading: false,
  loadingMessage: null,
  activeModal: null,
  modalData: null,
  currentVideoId: null,
  isVideoPlaying: false,
  videoProgress: 0,
  toast: null,
  isOnline: true,
  keyboardVisible: false,
}

export const uiStore$ = observable<UIState>(defaultUIState)

// Actions
export const uiActions = {
  setLoading: (loading: boolean, message?: string) => {
    uiStore$.isLoading.set(loading)
    uiStore$.loadingMessage.set(message ?? null)
  },

  openModal: (modalId: string, data?: Record<string, unknown>) => {
    uiStore$.activeModal.set(modalId)
    uiStore$.modalData.set(data ?? null)
  },

  closeModal: () => {
    uiStore$.activeModal.set(null)
    uiStore$.modalData.set(null)
  },

  setCurrentVideo: (videoId: string | null) => {
    uiStore$.currentVideoId.set(videoId)
    uiStore$.videoProgress.set(0)
  },

  setVideoPlaying: (playing: boolean) => {
    uiStore$.isVideoPlaying.set(playing)
  },

  setVideoProgress: (progress: number) => {
    uiStore$.videoProgress.set(progress)
  },

  showToast: (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    uiStore$.toast.set({ visible: true, message, type })
    // Auto-hide after 3 seconds
    setTimeout(() => {
      uiStore$.toast.set(null)
    }, 3000)
  },

  hideToast: () => {
    uiStore$.toast.set(null)
  },

  setOnline: (online: boolean) => {
    uiStore$.isOnline.set(online)
  },

  setKeyboardVisible: (visible: boolean) => {
    uiStore$.keyboardVisible.set(visible)
  },
}
