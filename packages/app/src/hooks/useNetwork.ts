import { useEffect } from 'react'
import { useObservable } from '@legendapp/state/react'
import { uiStore$, uiActions } from '../store/ui.store'

export function useNetwork() {
  const isOnline = useObservable(uiStore$.isOnline)
  
  return {
    isOnline: isOnline.get(),
    setOnline: uiActions.setOnline,
  }
}

export function useToast() {
  const toast = useObservable(uiStore$.toast)
  
  return {
    toast: toast.get(),
    showToast: uiActions.showToast,
    hideToast: uiActions.hideToast,
  }
}

export function useLoading() {
  const isLoading = useObservable(uiStore$.isLoading)
  const loadingMessage = useObservable(uiStore$.loadingMessage)
  
  return {
    isLoading: isLoading.get(),
    loadingMessage: loadingMessage.get(),
    setLoading: uiActions.setLoading,
  }
}

export function useModal() {
  const activeModal = useObservable(uiStore$.activeModal)
  const modalData = useObservable(uiStore$.modalData)
  
  return {
    activeModal: activeModal.get(),
    modalData: modalData.get(),
    openModal: uiActions.openModal,
    closeModal: uiActions.closeModal,
    isOpen: (modalId: string) => activeModal.get() === modalId,
  }
}

