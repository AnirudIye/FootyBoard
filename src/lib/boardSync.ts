import { api } from './api'
import { isPersistedBoard } from './persistence'
import type { PersistedBoard } from './persistence'
import { useBoardStore } from '../store/boardStore'
import { useBoardsStore } from '../store/boardsStore'

/**
 * Reading and writing the open board.
 *
 * Both the autosave loop and the realtime hook need these, and they need them
 * to behave identically — a board re-read because a peer pressed undo must be
 * handled exactly like a board read when it was opened.
 */

type LoadMode = 'open' | 'adopt'

/**
 * Pull the board from the server.
 *
 * `open` is a fresh load: history is discarded, the tool resets. `adopt` is a
 * peer having replaced the board underneath us, which keeps the tool, zoom and
 * whatever of the selection still exists.
 */
export async function loadBoard(boardId: string, mode: LoadMode): Promise<boolean> {
  const { board } = await api.getBoard<PersistedBoard>(boardId)

  // A board from an older version, or one that arrived damaged, is not worth
  // crashing over.
  if (!isPersistedBoard(board.data)) return false

  if (mode === 'adopt') useBoardStore.getState().adoptRemote(board.data)
  else useBoardStore.getState().loadPersisted(board.data)
  return true
}

/**
 * Write immediately, skipping the debounce.
 *
 * Used when someone else is waiting on the result: a peer joining and asking
 * for the current state, or this client being the last one able to record an
 * edit before it leaves.
 */
export async function flushSave(boardId: string): Promise<void> {
  const boards = useBoardsStore.getState()
  const name = boards.boards.find((b) => b.id === boardId)?.name
  boards.setSaveState('saving')
  try {
    await api.saveBoard(boardId, name ?? 'My board', useBoardStore.getState().getPersistable())
    boards.touch(boardId)
    boards.setSaveState('saved')
  } catch (err) {
    boards.setSaveState('offline')
    throw err
  }
}
