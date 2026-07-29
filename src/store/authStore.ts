import { create } from 'zustand'
import { api } from '../lib/api'

interface AuthState {
  /** Email of the signed-in account, or null when browsing as a guest. */
  email: string | null
  /** True once the server has been asked who we are, so the UI can wait. */
  ready: boolean
  restore: () => Promise<void>
  signUp: (
    email: string,
    password: string,
    acceptedTerms: boolean,
    securityQuestionId: string,
    securityAnswer: string,
  ) => Promise<void>
  logIn: (email: string, password: string) => Promise<void>
  logOut: () => Promise<void>
  deleteAccount: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  email: null,
  ready: false,

  /**
   * The session lives in an HttpOnly cookie, so the only way to know whether
   * we are signed in is to ask. A 401 here is the normal guest case, not a
   * failure worth surfacing.
   */
  restore: async () => {
    try {
      const { user } = await api.me()
      set({ email: user.email, ready: true })
    } catch {
      set({ email: null, ready: true })
    }
  },

  signUp: async (email, password, acceptedTerms, securityQuestionId, securityAnswer) => {
    const { user } = await api.signUp(
      email,
      password,
      acceptedTerms,
      securityQuestionId,
      securityAnswer,
    )
    set({ email: user.email, ready: true })
  },

  logIn: async (email, password) => {
    const { user } = await api.logIn(email, password)
    set({ email: user.email, ready: true })
  },

  logOut: async () => {
    await api.logOut()
    set({ email: null })
  },

  deleteAccount: async () => {
    await api.deleteAccount()
    set({ email: null })
  },
}))
