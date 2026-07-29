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
  // crashing over. Note what is deliberately *not* done here: the store is left
  // exactly as it was. Whatever the caller shows instead did not come from this
  // board, so it must not end up claiming to be it, or the stand-in gets
  // written over the record that failed to parse and the original is gone for
  // good rather than merely unreadable by this version.
  if (!isPersistedBoard(board.data)) return false

  if (mode === 'adopt') useBoardStore.getState().adoptRemote(board.data)
  else useBoardStore.getState().loadPersisted(board.data)
  useBoardStore.getState().setBoardId(boardId)
  return true
}

/**
 * Write immediately, skipping the debounce.
 *
 * Used when someone else is waiting on the result: a peer joining and asking
 * for the current state, or this client being the last one able to record an
 * edit before it leaves.
 *
 * Returns whether anything was written. False means the write was refused
 * because the store is not holding this board, which is a guard rather than a
 * failure: nothing is wrong with the server and there is nothing to retry.
 */
export async function flushSave(boardId: string): Promise<boolean> {
  // The one assertion that closes the whole class. Every save is scheduled
  // against the board that was open when the edit happened, and the debounce
  // means it runs later, by which time something may have swapped the contents
  // underneath it: a create that has not resolved yet, a board that failed to
  // parse and was replaced by a blank stand-in, a sign-out. `PUT` on a board is
  // a whole-row overwrite with no version history behind it, so a save
  // attributed to the wrong board is not a glitch, it is the end of that work.
  // Refuse rather than guess.
  if (useBoardStore.getState().boardId !== boardId) return false

  const boards = useBoardsStore.getState()
  // Never invent a name. The list is one page deep, so a board opened from a
  // link may not be in it at all, and the literal that used to stand in here
  // was written straight back over the owner's title on the next autosave.
  // Null means "leave it as it is", which the server honours.
  const name = boards.boards.find((b) => b.id === boardId)?.name ?? null
  boards.setSaveState('saving')
  try {
    await api.saveBoard(boardId, name, useBoardStore.getState().getPersistable())
    boards.touch(boardId)
    boards.setSaveState('saved')
    return true
  } catch (err) {
    boards.setSaveState('offline')
    throw err
  }
}
