/**
 * Global toast notification state (Legend State observable).
 *
 * Manages a queue of toast messages displayed by the ToastContainer component.
 * TelemetryLogger calls `addToast` on error-level events so that users see
 * a short message plus a reference ID they can share with support.
 */

import { observable } from '@legendapp/state'

export type ToastType = 'error' | 'warn' | 'info' | 'success'

export interface ToastEntry {
  /** Unique ID for React key and dismiss tracking. */
  id: string
  /** Toast severity — controls color and duration. */
  type: ToastType
  /** Short human-readable message (≤2 lines). */
  message: string
  /** Reference ID linking back to the clientLogs entry. */
  referenceId?: string
  /** Timestamp (ms since epoch) when the toast was created. */
  createdAt: number
}

interface ToastState {
  toasts: ToastEntry[]
}

const MAX_VISIBLE = 3
const AUTO_DISMISS_MS = 6000

let toastCounter = 0

export const toastStore$ = observable<ToastState>({
  toasts: [],
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const toastActions = {
  /**
   * Add a toast to the queue.  If the queue already has MAX_VISIBLE items,
   * the oldest is dismissed first.
   */
  addToast: (type: ToastType, message: string, referenceId?: string): string => {
    const id = `toast-${++toastCounter}-${Date.now().toString(36)}`
    const entry: ToastEntry = {
      id,
      type,
      message,
      referenceId,
      createdAt: Date.now(),
    }

    // Enforce max visible count — remove oldest if at limit
    const current = toastStore$.toasts.get()
    if (current.length >= MAX_VISIBLE) {
      toastStore$.toasts.set(current.slice(1))
    }

    toastStore$.toasts.push(entry)

    // Auto-dismiss after timeout
    setTimeout(() => {
      toastActions.dismiss(id)
    }, AUTO_DISMISS_MS)

    return id
  },

  /**
   * Dismiss a toast by ID.
   */
  dismiss: (id: string): void => {
    const current = toastStore$.toasts.get()
    toastStore$.toasts.set(current.filter((t) => t.id !== id))
  },
}
