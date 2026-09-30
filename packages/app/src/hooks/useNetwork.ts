import { useValue } from '@legendapp/state/react'
import * as Network from 'expo-network'
import { useEffect } from 'react'
import { uiActions, uiStore$ } from '../store/ui.store'

/**
 * Keep `uiStore$.isOnline` in sync with device connectivity. Mount once.
 * Treats "connected and not explicitly unreachable" as online, because
 * isInternetReachable is null on some platforms.
 */
export function useNetworkStatusSync() {
  useEffect(() => {
    const apply = (state: Network.NetworkState) => {
      uiActions.setOnline(state.isConnected !== false && state.isInternetReachable !== false)
    }
    const subscription = Network.addNetworkStateListener(apply)
    Network.getNetworkStateAsync()
      .then(apply)
      .catch(() => {
        // Best effort; the listener corrects it on the next change.
      })
    return () => subscription.remove()
  }, [])
}

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
