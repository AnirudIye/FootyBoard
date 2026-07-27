import { create } from 'zustand'
import { api } from '../lib/api'
import type { BoardSummary } from '../lib/api'

const LAST_OPENED_KEY = 'soccerboard.lastBoard'

/** What the last write to the server did, so the UI never hides a failure. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'offline'

interface BoardsState {
  boards: BoardSummary[]
  currentId: string | null
  nextCursor: string | null
  loading: boolean
  saveState: SaveState
  setSaveState: (state: SaveState) => void
  /** Loads the first page and picks a board to open. */
  load: () => Promise<string | null>
  loadMore: () => Promise<void>
  select: (id: string) => void
  create: (name: string, data: unknown) => Promise<string>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Keeps the strip's timestamps honest after an autosave. */
  touch: (id: string) => void
  /**
   * Keeps the list honest after the owner changes the editing lock.
   *
   * Without this the list keeps whatever it was told when it was fetched, and
   * anything reading the lock from here shows the state as of page load.
   */
  setMembersCanEdit: (id: string, membersCanEdit: boolean) => void
  reset: () => void
}

const PAGE = 20

/** Remembering the last board means a reload reopens what you were working on. */
const readLastOpened = (): string | null => {
  try {
    return localStorage.getItem(LAST_OPENED_KEY)
  } catch {
    return null
  }
}

const writeLastOpened = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_OPENED_KEY, id)
    else localStorage.removeItem(LAST_OPENED_KEY)
  } catch {
    // Only costs us reopening the most recent board instead.
  }
}

export const useBoardsStore = create<BoardsState>((set, get) => ({
  boards: [],
  currentId: null,
  nextCursor: null,
  loading: false,
  saveState: 'idle',
  setSaveState: (saveState) => set({ saveState }),

  load: async () => {
    set({ loading: true })
    try {
      const { boards, nextCursor } = await api.listBoards(PAGE)
      // A board already chosen wins. A share link picks its board and can
      // finish before this request does, and overwriting the choice here is
      // what made a followed link flash the right board and then drop back to
      // whatever was open last. Otherwise reopen the last board if it still
      // exists, and failing that the most recent.
      const chosen = get().currentId
      const remembered = readLastOpened()
      const currentId =
        (chosen && boards.some((b) => b.id === chosen) ? chosen : null) ??
        (remembered && boards.some((b) => b.id === remembered) ? remembered : boards[0]?.id) ??
        null
      set({ boards, nextCursor, currentId, loading: false })
      writeLastOpened(currentId)
      return currentId
    } catch (err) {
      set({ loading: false })
      throw err
    }
  },

  loadMore: async () => {
    const { nextCursor, boards } = get()
    if (!nextCursor) return
    const page = await api.listBoards(PAGE, nextCursor)
    set({ boards: [...boards, ...page.boards], nextCursor: page.nextCursor })
  },

  select: (id) => {
    set({ currentId: id })
    writeLastOpened(id)
  },

  create: async (name, data) => {
    const { board } = await api.createBoard(name, data)
    set((s) => ({ boards: [board, ...s.boards], currentId: board.id }))
    writeLastOpened(board.id)
    return board.id
  },

  rename: async (id, name) => {
    await api.renameBoard(id, name)
    set((s) => ({ boards: s.boards.map((b) => (b.id === id ? { ...b, name } : b)) }))
  },

  remove: async (id) => {
    await api.deleteBoard(id)
    const remaining = get().boards.filter((b) => b.id !== id)
    const currentId = get().currentId === id ? (remaining[0]?.id ?? null) : get().currentId
    set({ boards: remaining, currentId })
    writeLastOpened(currentId)
  },

  touch: (id) =>
    set((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, updatedAt: new Date().toISOString() } : b)),
    })),

  setMembersCanEdit: (id, membersCanEdit) =>
    set((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, membersCanEdit } : b)),
    })),

  reset: () => {
    writeLastOpened(null)
    set({ boards: [], currentId: null, nextCursor: null, loading: false, saveState: 'idle' })
  },
}))

// Dev-only: expose the store for debugging in the browser console. Stripped
// from production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __boardsStore?: unknown }).__boardsStore = useBoardsStore
}
