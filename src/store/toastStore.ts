import { create } from 'zustand'
import { id } from '../lib/id'

export interface Toast {
  id: string
  message: string
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  toast: (message: string, action?: Toast['action']) => void
  dismiss: (toastId: string) => void
}

const LIFETIME = 4000

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  toast: (message, action) => {
    const toastId = id()
    set((s) => ({ toasts: [...s.toasts, { id: toastId, message, action }] }))
    window.setTimeout(() => get().dismiss(toastId), LIFETIME)
  },
  dismiss: (toastId) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toastId) })),
}))

export const toast = (message: string, action?: Toast['action']) =>
  useToastStore.getState().toast(message, action)
