import { create } from 'zustand'

/**
 * Whether the invitation to choose a display name has been answered.
 *
 * Its own key rather than a field on the user, because this is a preference of
 * this browser and not a fact about the account: the server is never told and
 * has no use for it. The shape is `soccerboard.assistant.notice`'s, down to the
 * `'1'` and the swallowed write, so a dismissible notice is remembered one way
 * here rather than two.
 */
const NOTICE_KEY = 'soccerboard.displayName.notice'

interface NameNoticeState {
  noticeDismissed: boolean
  dismissNotice: () => void
}

export const useNameNoticeStore = create<NameNoticeState>((set) => ({
  noticeDismissed: typeof localStorage !== 'undefined' && localStorage.getItem(NOTICE_KEY) === '1',

  dismissNotice: () => {
    try {
      localStorage.setItem(NOTICE_KEY, '1')
    } catch {
      // ignore storage failures; the notice simply reappears next session
    }
    set({ noticeDismissed: true })
  },
}))
