import { api } from './api'
import { ConflictError } from './errors'
import { isPersistedBoard } from './persistence'
import type { PersistedBoard } from './persistence'
import { useBoardStore } from '../store/boardStore'
import { useBoardsStore } from '../store/boardsStore'
import { toast } from '../store/toastStore'

/**
 * Reading and writing the open board.
 *
 * Both the autosave loop and the realtime hook need these, and they need them
 * to behave identically — a board re-read because a peer pressed undo must be
 * handled exactly like a board read when it was opened.
 */

type LoadMode = 'open' | 'adopt'

/**
 * Give up on the open board, and keep saying so.
 *
 * Reached three ways, all of them meaning the same thing: the row now holds
 * something this version cannot parse, written by somebody else, and what is on
 * screen is therefore both out of date and unwritable. A peer's `replaced`, a
 * `lock` re-read, and a refused write's catch-up read all land here.
 *
 * Three things, and the first is what makes the other two true.
 *
 * 1. **Let go of the board.** Saving what is on screen over it would turn "we
 *    could not read this" into "this is gone", over a *newer* board than ours.
 *    Clearing the id is the guard `flushSave` already carries, not a second one.
 * 2. **Say so, and keep saying it.** `blocked` is the standing condition that
 *    already means "no write is possible at all here". Naming this differently
 *    would be a second word for one condition. It ends when a board opens
 *    successfully, which for this board means a later re-read that parses.
 * 3. **Stop describing this board to the room**, which falls out of 1: the
 *    realtime sinks guard on the store still holding this board.
 *
 * It lives here rather than in `useRealtime` because three callers now need it,
 * and a rule this repo has already shipped dark across a file boundary five
 * times does not get a third hand-written copy.
 */
export function rereadFailed(): void {
  useBoardStore.getState().setBoardId(null)
  useBoardsStore.getState().setSaveState('blocked')
  toast(
    'This board changed and could not be read, so what is on screen is out of date and is not being saved. Your saved copy is untouched.',
  )
}

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

  /**
   * A board with no generation is one this client cannot safely write to.
   *
   * Every write states the base it is made on, and a base this client does not
   * have is one it cannot supply — so the board would open, look completely
   * normal, and silently never save again while the indicator rested on "Ready".
   * That is the one thing the indicator must never do. Answering false instead
   * sends it down the path that already exists for a board this version cannot
   * work with: try another board, and failing that say plainly that nothing is
   * being written.
   */
  const generation = board.generation
  if (!Number.isInteger(generation)) return false

  /**
   * A read never moves the board backwards.
   *
   * Closing the write race puts two reads of the same board in flight on two
   * different paths — the conflict handler below, and `useRealtime`'s in-order
   * chain — and the chain cannot see the other one. Two REST round trips settle
   * in whichever order the network hands them over, so without this the older
   * read can land last and win, which is the divergence this whole mechanism
   * exists to stop, reintroduced one level up.
   *
   * A property of the loader rather than a second chain, so neither path has to
   * know the other exists. Only for `adopt`: an `open` is a deliberate move to
   * a board, holds nothing to compare against, and must always land. Equal
   * generations still adopt, because ordinary saves change contents without
   * changing lineage, so the same generation can carry newer contents.
   */
  const held = useBoardStore.getState()
  if (
    mode === 'adopt' &&
    held.boardId === boardId &&
    held.boardGeneration !== null &&
    (generation as number) < held.boardGeneration
  ) {
    return true
  }

  if (mode === 'adopt') useBoardStore.getState().adoptRemote(board.data)
  else useBoardStore.getState().loadPersisted(board.data)
  useBoardStore.getState().setBoardId(boardId, generation as number)
  return true
}

/**
 * Write immediately, skipping the debounce.
 *
 * Used when someone else is waiting on the result: a peer joining and asking
 * for the current state, or this client being the last one able to record an
 * edit before it leaves.
 *
 * `replacing` marks a write that will also be announced as `replaced` — undo,
 * redo, reset, a format change, answering a joiner. It is what moves the board's
 * generation, and the two must stay together: a replacement that did not bump
 * leaves every peer's stale base looking current, and a bump without an
 * announcement refuses every peer's next write with nothing telling them why.
 *
 * Returns whether anything was written. False means the write was refused —
 * because the store is not holding this board, or because the board has been
 * replaced since these contents were read — and in neither case is there
 * anything to retry or anything to tell the room.
 */
export async function flushSave(
  boardId: string,
  { replacing = false }: { replacing?: boolean } = {},
): Promise<boolean> {
  // The one assertion that closes the whole class. Every save is scheduled
  // against the board that was open when the edit happened, and the debounce
  // means it runs later, by which time something may have swapped the contents
  // underneath it: a create that has not resolved yet, a board that failed to
  // parse and was replaced by a blank stand-in, a sign-out. A save attributed to
  // the wrong board is not a glitch, it is the end of that work. Refuse rather
  // than guess.
  //
  // The generation is the same assertion about the same fact: contents whose
  // base is unknown cannot state one, and a write with no base is a write that
  // cannot be refused when it should be.
  const held = useBoardStore.getState()
  if (held.boardId !== boardId || held.boardGeneration === null) return false
  const baseGeneration = held.boardGeneration

  const boards = useBoardsStore.getState()
  // Never invent a name. The list is one page deep, so a board opened from a
  // link may not be in it at all, and the literal that used to stand in here
  // was written straight back over the owner's title on the next autosave.
  // Null means "leave it as it is", which the server honours.
  const name = boards.boards.find((b) => b.id === boardId)?.name ?? null
  boards.setSaveState('saving')
  try {
    const written = await api.saveBoard(
      boardId,
      name,
      useBoardStore.getState().getPersistable(),
      baseGeneration,
      replacing,
    )

    /**
     * Take on the generation the write landed on.
     *
     * Guarded on the board id because there is an await above and the store can
     * swap across it: stamping a generation onto whatever happens to be open now
     * is the same defect as writing to it.
     *
     * Guarded on the value because an answer that does not name one must leave
     * the base alone rather than clear it. A non-replacing write does not move
     * the generation, so the base already held is still right; and clearing it
     * would refuse every later write *silently*, with the indicator resting on
     * "Ready", which is the one thing it must never do. If the base really has
     * gone stale, the next write is refused and the re-read puts it back — so
     * the failure mode here is one wasted round trip rather than a board that
     * quietly stops saving.
     */
    const next = written?.board?.generation
    if (Number.isInteger(next) && useBoardStore.getState().boardId === boardId) {
      useBoardStore.getState().setBoardId(boardId, next)
    }
    boards.touch(boardId)
    boards.setSaveState('saved')
    return true
  } catch (err) {
    if (err instanceof ConflictError) return adoptTheWinner(boardId)
    boards.setSaveState('offline')
    throw err
  }
}

/**
 * A refused write, answered by reading rather than by trying again.
 *
 * The server refuses a write whose base has been superseded, which happens only
 * when somebody replaced the whole board first: an undo, a redo, a reset, a
 * format change. So these contents come from a lineage the board is no longer
 * on, and the honest thing is to take on the board that won.
 *
 * **Not a retry on a fresh base.** That would take contents which were just
 * correctly refused and give them a base that makes them acceptable, which is
 * the defect this exists to close, performed deliberately.
 *
 * Nothing is said. The board catching up is what a peer's `replaced` does
 * anyway, the person is watching it happen, and a toast here would fire on every
 * contended undo in a busy room.
 */
async function adoptTheWinner(boardId: string): Promise<boolean> {
  const boards = useBoardsStore.getState()
  try {
    // False means the winning board will not parse, which is the same dead end
    // a peer's unreadable `replaced` reaches, so it ends in the same place.
    if (!(await loadBoard(boardId, 'adopt'))) rereadFailed()
    // Nothing was written, so `saved` would be untrue. `offline` would be untrue
    // too — the server is fine, and the write that follows this read lands.
    // `blocked` is for when no write is possible at all, and one is.
    else boards.setSaveState('idle')
  } catch {
    // The read did not land. The board is perfectly writable and the next
    // attempt may well succeed, which is exactly what `offline` means.
    boards.setSaveState('offline')
  }
  return false
}
