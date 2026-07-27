import { create } from 'zustand'
import { id } from '../lib/id'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** True when the assistant made a board change that can be reverted. */
  undoable?: boolean
}

const NOTICE_KEY = 'soccerboard.assistant.notice'
const CONSENT_KEY = 'soccerboard.assistant.ai'

const readConsent = () => {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

interface AssistantState {
  open: boolean
  messages: ChatMessage[]
  noticeDismissed: boolean
  /**
   * Whether the server has an AI key configured.
   *
   * False by default and only ever turned on by asking the server, so an
   * install with no key never shows a waiting state for a request it is not
   * going to make.
   */
  aiAvailable: boolean
  /**
   * Whether the person has agreed to their messages leaving the device.
   *
   * A previous build promised, in the panel itself, that an online assistant
   * would ask first. This is that promise kept: a configured key makes the AI
   * *offerable*, never automatically on.
   */
  aiConsented: boolean
  /** True while a request to the AI fallback is in flight. */
  thinking: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
  setAiAvailable: (available: boolean) => void
  setAiConsented: (consented: boolean) => void
  setThinking: (thinking: boolean) => void
  push: (role: ChatMessage['role'], text: string, undoable?: boolean) => void
  dismissNotice: () => void
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  messages: [],
  noticeDismissed:
    typeof localStorage !== 'undefined' && localStorage.getItem(NOTICE_KEY) === '1',
  aiAvailable: false,
  aiConsented: readConsent(),
  thinking: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setAiAvailable: (aiAvailable) => set({ aiAvailable }),
  setAiConsented: (aiConsented) => {
    try {
      localStorage.setItem(CONSENT_KEY, aiConsented ? '1' : '0')
    } catch {
      // Only costs us asking again next session.
    }
    set({ aiConsented })
  },
  setThinking: (thinking) => set({ thinking }),
  push: (role, text, undoable) =>
    set((s) => ({ messages: [...s.messages, { id: id(), role, text, undoable }] })),
  dismissNotice: () => {
    try {
      localStorage.setItem(NOTICE_KEY, '1')
    } catch {
      // ignore storage failures; the notice simply reappears next session
    }
    set({ noticeDismissed: true })
  },
}))
