import { useValue } from '@legendapp/state/react'
import { uiActions, uiStore$ } from '../store/ui.store'

export function useNetwork() {
  const isOnline = useValue(uiStore$.isOnline)

  return {
    isOnline,
    setOnline: uiActions.setOnline,
  }
}

export function useToast() {
  const toast = useValue(uiStore$.toast)

  return {
    toast,
    showToast: uiActions.showToast,
    hideToast: uiActions.hideToast,
  }
}

export function useLoading() {
  const isLoading = useValue(uiStore$.isLoading)
  const loadingMessage = useValue(uiStore$.loadingMessage)

  return {
    isLoading,
    loadingMessage,
    setLoading: uiActions.setLoading,
  }
}

export function useModal() {
  const activeModal = useValue(uiStore$.activeModal)
  const modalData = useValue(uiStore$.modalData)

  return {
    activeModal,
    modalData,
    openModal: uiActions.openModal,
    closeModal: uiActions.closeModal,
    isOpen: (modalId: string) => {
      const current = activeModal
      return current === modalId
    },
  }
}
