import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { api } from './api'
import { AppError, ConflictError } from './errors'
import { loadBoard, flushSave } from './boardSync'
import type { PersistedBoard } from './persistence'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'
import { useBoardsStore } from '../store/boardsStore'
import { useToastStore } from '../store/toastStore'

/**
 * Which write wins, and what the loser does about it.
 *
 * `PUT` was last-writer-wins with nothing behind it, so a debounced autosave
 * carrying contents from before somebody pressed undo could commit *after* the
 * undo and win. The loser's catch-up read then handed back its own stale board,
 * the winner's next autosave broadcast nothing, and the room never converged
 * again. That is gap 10, and the half of it that lives here is the client: it has
 * to write on a stated base, and it has to answer a refusal by re-reading rather
 * than by trying again with a base that would make it acceptable.
 *
 * These drive the real `boardSync` against the real board store with only `api`
 * mocked. The defect was a disagreement between what the save path did and what
 * the store was holding, so a test that stood in for either half would keep
 * passing while the shipped pair diverged.
 */

vi.mock('./api', () => ({
  api: {
    getBoard: vi.fn(),
    saveBoard: vi.fn(),
    listBoards: vi.fn(),
    createBoard: vi.fn(),
    renameBoard: vi.fn(),
    deleteBoard: vi.fn(),
  },
}))

const mockApi = api as unknown as { getBoard: Mock; saveBoard: Mock }

/** A board carrying one identifiable frame, so two of them can be told apart. */
const tagged = (tag: string): PersistedBoard => ({
  ...defaultPersistedBoard(),
  frames: [{ id: tag, label: tag, tokens: {} }],
})

const heldTag = () => useBoardStore.getState().frames[0]?.id

/** What the server answers a `GET` with. */
const serves = (data: PersistedBoard | unknown, generation: number) =>
  mockApi.getBoard.mockResolvedValue({ board: { id: 'board-1', data, generation } })

/** What the server answers a `PUT` with when it accepts one. */
const accepts = (generation: number) =>
  mockApi.saveBoard.mockResolvedValue({ board: { id: 'board-1', name: 'B', generation } })

/** Open `board-1` for real, at the generation given. */
const openAt = async (generation: number, tag = 'base') => {
  serves(tagged(tag), generation)
  useBoardsStore.setState({ boards: [], currentId: 'board-1', saveState: 'idle' })
  expect(await loadBoard('board-1', 'open')).toBe(true)
}

/** The arguments of the last write that reached the server. */
const lastWrite = () => mockApi.saveBoard.mock.calls.at(-1)!

beforeEach(() => {
  vi.clearAllMocks()
  accepts(7)
})

afterEach(() => {
  useBoardStore.getState().initDefaultBoard()
  useBoardsStore.setState({ boards: [], currentId: null, saveState: 'idle' })
  useToastStore.setState({ toasts: [] })
})

describe('the base a write is made on', () => {
  it('writes on the generation the board was read at', async () => {
    await openAt(7)

    expect(await flushSave('board-1')).toBe(true)
    expect(lastWrite()).toContain(7)
  })

  it('moves to the generation the server hands back, so the next write is current', async () => {
    // Without this the client keeps writing on the base it opened at, and the
    // first replacement it makes itself would refuse every write it made after.
    await openAt(7)
    accepts(8)

    await flushSave('board-1', { replacing: true })
    accepts(8)
    await flushSave('board-1')

    expect(lastWrite()).toContain(8)
  })

  it('refuses to write a board whose generation it does not know', async () => {
    // The window between creating a board and reading it back. Refuse rather
    // than guess, which is the rule this file already runs on for the id.
    useBoardStore.getState().initDefaultBoard('board-1')

    expect(await flushSave('board-1')).toBe(false)
    expect(mockApi.saveBoard).not.toHaveBeenCalled()
  })
})

describe('a write the room has already moved past', () => {
  /** The server refuses: somebody replaced the whole board first. */
  const refuses = (generation: number) =>
    mockApi.saveBoard.mockRejectedValue(
      new ConflictError('This board was changed somewhere else.', generation),
    )

  it('re-reads rather than trying again on a base that would be accepted', async () => {
    // Retrying is the defect wearing a seatbelt: it takes contents that were
    // just correctly refused and gives them a base that makes them acceptable.
    await openAt(7, 'mine')
    refuses(8)
    serves(tagged('theirs'), 8)

    expect(await flushSave('board-1')).toBe(false)
    expect(mockApi.saveBoard).toHaveBeenCalledTimes(1)
    expect(mockApi.getBoard).toHaveBeenCalledTimes(2)
  })

  it('takes on the board that won', async () => {
    await openAt(7, 'mine')
    refuses(8)
    serves(tagged('theirs'), 8)

    await flushSave('board-1')

    // Convergence, which is the whole point: the client that lost the race ends
    // up holding what the server holds rather than what it wrote.
    expect(heldTag()).toBe('theirs')
    expect(useBoardStore.getState().boardId).toBe('board-1')
  })

  it('writes on the new base afterwards, and that write is accepted', async () => {
    await openAt(7, 'mine')
    refuses(8)
    serves(tagged('theirs'), 8)
    await flushSave('board-1')

    accepts(8)
    expect(await flushSave('board-1')).toBe(true)
    expect(lastWrite()).toContain(8)
  })

  it('does not leave the indicator claiming the board was saved', async () => {
    // Nothing was written, so "Saved" is untrue. `offline` would be untrue too:
    // the server is fine and the next write lands. `blocked` would be worse
    // still, since it is the standing condition that means no write is possible
    // at all, and one is.
    await openAt(7, 'mine')
    refuses(8)
    serves(tagged('theirs'), 8)

    await flushSave('board-1')

    expect(useBoardsStore.getState().saveState).toBe('idle')
  })

  it('says nothing, because the board simply catches up', async () => {
    // A toast here would fire on every contended undo in a busy room and would
    // describe something the person is already watching happen.
    await openAt(7, 'mine')
    refuses(8)
    serves(tagged('theirs'), 8)

    await flushSave('board-1')

    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('ends where every other unreadable board ends when the re-read will not parse', async () => {
    // The third route into "a board that cannot be opened", and it has to end in
    // the same place as the other two: let go of the board so nothing writes the
    // stale contents over a newer row, and keep saying so.
    await openAt(7, 'mine')
    refuses(8)
    mockApi.getBoard.mockResolvedValue({ board: { id: 'board-1', data: { v: 1 }, generation: 8 } })

    expect(await flushSave('board-1')).toBe(false)
    expect(useBoardStore.getState().boardId).toBe(null)
    expect(useBoardsStore.getState().saveState).toBe('blocked')
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('reports a re-read that did not land, without claiming the board is unwritable', async () => {
    // A request that failed to reach the server is `offline`, not `blocked`: the
    // next one may well land, and the board is perfectly writable meanwhile.
    await openAt(7, 'mine')
    refuses(8)
    mockApi.getBoard.mockRejectedValue(new AppError("Can't reach the server."))

    expect(await flushSave('board-1')).toBe(false)
    expect(useBoardsStore.getState().saveState).toBe('offline')
  })
})

describe('a re-read that arrives out of order', () => {
  /**
   * Closing gap 10 puts two reads of the same board in flight on two different
   * paths: the 409 handler inside `flushSave`, and the `replaced` handler on
   * `useRealtime`'s in-order chain. The chain cannot see the first one, and two
   * REST round trips settle in whichever order the network hands them over, so
   * the older read can land last and win.
   *
   * Refusing to move backwards closes that without either path having to know
   * about the other, which is why it is a property of the loader rather than a
   * second chain.
   */
  it('ignores a board older than the one already held', async () => {
    await openAt(8, 'newer')
    serves(tagged('older'), 7)

    // True rather than false: being already ahead is not a failed read, and
    // answering false would send the caller down the "cannot be opened" path
    // over a board that is perfectly fine.
    expect(await loadBoard('board-1', 'adopt')).toBe(true)
    expect(heldTag()).toBe('newer')
  })

  it('still takes on a board newer than the one held', async () => {
    await openAt(8, 'newer')
    serves(tagged('newest'), 9)

    expect(await loadBoard('board-1', 'adopt')).toBe(true)
    expect(heldTag()).toBe('newest')
  })

  it('takes on a board on the same generation, since an ordinary save changes contents but not lineage', async () => {
    await openAt(8, 'newer')
    serves(tagged('same-lineage'), 8)

    expect(await loadBoard('board-1', 'adopt')).toBe(true)
    expect(heldTag()).toBe('same-lineage')
  })

  it('does not compare against a different board', async () => {
    // The guard is about one board's own lineage. A generation from another
    // board is not a lower number on the same scale, it is a different scale.
    await openAt(8, 'newer')
    mockApi.getBoard.mockResolvedValue({
      board: { id: 'board-2', data: tagged('other-board'), generation: 1 },
    })

    expect(await loadBoard('board-2', 'adopt')).toBe(true)
    expect(heldTag()).toBe('other-board')
  })
})
