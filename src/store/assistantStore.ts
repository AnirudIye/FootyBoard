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

interface AssistantState {
  open: boolean
  messages: ChatMessage[]
  noticeDismissed: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
  push: (role: ChatMessage['role'], text: string, undoable?: boolean) => void
  dismissNotice: () => void
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  messages: [],
  noticeDismissed:
    typeof localStorage !== 'undefined' && localStorage.getItem(NOTICE_KEY) === '1',
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
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
