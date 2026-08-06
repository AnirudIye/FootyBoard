import { create } from 'zustand'

/**
 * Whether the notes pad is open, and how big it is.
 *
 * **Only the panel's own state lives here. The notes themselves are in
 * `boardStore`**, because they are the board's rather than this browser's: they
 * save with it, travel to the room with it, and are sealed with it at rest. This
 * store is the same shape as `assistantStore`'s `open` and for the same reason —
 * a panel that is open is not a fact about a board.
 *
 * `expanded` is deliberately not persisted anywhere. It is the answer to "I need
 * more room for this paragraph", which is about the paragraph rather than about
 * the person, and the five `soccerboard.` keys in localStorage are preferences
 * somebody would be annoyed to have to set twice. Reopening at the size you left
 * is a smaller kindness than being unable to explain why the pad opened huge.
 */
interface NotesState {
  open: boolean
  expanded: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  setExpanded: (expanded: boolean) => void
}

export const useNotesStore = create<NotesState>((set) => ({
  open: false,
  expanded: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setExpanded: (expanded) => set({ expanded }),
}))
