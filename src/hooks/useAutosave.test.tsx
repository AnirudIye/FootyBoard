import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../lib/api'
import type { BoardSummary } from '../lib/api'
import { SCHEMA_VERSION } from '../lib/persistence'
import type { PersistedBoard } from '../lib/persistence'
import { flushSave } from '../lib/boardSync'
import { AppError } from '../lib/errors'
import { useAutosave } from './useAutosave'
import BoardPicker from '../components/board/BoardPicker'
import SaveStatus from '../components/board/SaveStatus'
import { useAuthStore } from '../store/authStore'
import { useBoardsStore } from '../store/boardsStore'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'
import { useToastStore } from '../store/toastStore'

/**
 * A signed-in account, as the store now holds it.
 *
 * The store used to keep `email: string | null` and use it as the signed-in flag
 * too. An account can exist without an address now — a guest admitted by a join
 * code — so the flag is the presence of a user and the address is a field on it.
 */
const signedInUser = { id: 'u1', email: 'coach@example.test', displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: false, twoFactorEnabled: false }

/**
 * Creating a board must not be able to destroy the one already open.
 *
 * The shape of the bug this covers, which was deterministic rather than a race:
 * `+ New` reset the shared board store to a blank default *before* awaiting the
 * create. That mutation fired the autosave subscription, which scheduled a
 * debounced write bound to the board still open. Nothing cancelled that timer,
 * because cancellation hangs off the current board changing and the current
 * board only changes if the create resolves. So a create that failed, or that
 * simply took longer than the 800ms debounce, ended with
 * `PUT /api/boards/old` carrying a blank default board. `PUT` is a whole-row
 * overwrite and there is no version history behind it: the coach saw a toast
 * saying the board could not be created, and 800ms later their work was gone
 * from the server.
 *
 * These drive the real `useAutosave` and the real `BoardPicker` with only `api`
 * mocked, deliberately. The defect lived in the seam between those two files,
 * so a test that reimplemented either half would keep passing while the shipped
 * pair went back to destroying boards.
 */

vi.mock('../lib/api', () => ({
  api: {
    listBoards: vi.fn(),
    getBoard: vi.fn(),
    createBoard: vi.fn(),
    saveBoard: vi.fn(),
    renameBoard: vi.fn(),
    deleteBoard: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  listBoards: Mock
  getBoard: Mock
  createBoard: Mock
  saveBoard: Mock
}

const summary = (id: string, name: string): BoardSummary => ({
  id,
  name,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  role: 'owner',
})

const OLD = summary('old', 'Real board')
const NEW = summary('new', 'Board 2')

/** The open board, with something in it worth losing. */
const boardWithWork = (): PersistedBoard => ({
  ...defaultPersistedBoard(),
  frames: [{ id: 'f1', label: '1', tokens: {} }],
})

/**
 * Every write that reached the server, as `<board id> / <n> frames`.
 *
 * Readable on purpose. The failure this guards against is one `saveBoard` call
 * among several, and the thing that distinguishes it is which board it names
 * and how much of the work it is carrying, so a failing assertion should print
 * exactly that rather than two whole board payloads.
 */
const everyWrite = (): string[] =>
  mockApi.saveBoard.mock.calls.map(
    (call) => `${call[0]} / ${(call[2] as PersistedBoard).frames.length} frames`,
  )

/**
 * The picker and the indicator, driven by the real hook.
 *
 * `SaveStatus` is here rather than in a test of its own because the question it
 * answers is not "does it render the state it is given" but "does the state it
 * is given match what the save path will actually do". Those are two files
 * apart, and the defect lived in the gap.
 */
function Harness() {
  useAutosave()
  return (
    <>
      <BoardPicker />
      <SaveStatus />
    </>
  )
}

const renderApp = () =>
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  )

/** Render, and let the board list and the board itself finish loading. */
const openBoard = async () => {
  renderApp()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Open the picker and press `+ New`. Does not wait for the create to settle. */
const pressNew = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Real board' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '+ New' }))
  })
}

/** Long enough for every debounce beat, and every rearm, to have had its turn. */
const waitOutEveryTimer = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
}

beforeEach(() => {
  // Only the timers the debounce runs on. Faking rAF as well would leave the
  // motion components in the picker waiting on a clock nothing advances.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  localStorage.clear()

  mockApi.listBoards.mockResolvedValue({ boards: [OLD], nextCursor: null })
  // Every read carries the generation the board is on, because every write has
  // to state the base it was made from. A fixture without one describes a
  // response the server cannot send, and `loadBoard` refuses it rather than
  // opening a board that could never be saved to.
  mockApi.getBoard.mockImplementation(async (id: string) => ({
    board: {
      ...summary(id, id === 'old' ? 'Real board' : 'Board 2'),
      data: boardWithWork(),
      generation: 1,
    },
  }))
  mockApi.saveBoard.mockResolvedValue({ board: OLD })
  mockApi.createBoard.mockResolvedValue({ board: NEW })

  useBoardsStore.getState().reset()
  useBoardStore.getState().initDefaultBoard()
  useToastStore.setState({ toasts: [] })
  useAuthStore.setState({ user: signedInUser, ready: true })
})

afterEach(() => {
  // Unmounted before the auth store is torn down: signing out under a mounted
  // Harness is a React update nothing is wrapping.
  cleanup()
  vi.useRealTimers()
  useAuthStore.setState({ user: null, ready: false })
})

describe('creating a board while another one is open', () => {
  it('leaves the open board on the server when the create fails', async () => {
    await openBoard()
    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(useBoardStore.getState().boardId).toBe('old')

    mockApi.createBoard.mockRejectedValue(new AppError('The board could not be created.'))
    await pressNew()
    expect(mockApi.createBoard).toHaveBeenCalledTimes(1)

    await waitOutEveryTimer()

    // The assertion that matters, written so that a failure names the write
    // that did the damage. Every save has to be the coach's board carrying the
    // coach's work; the observed failure was `old` carrying zero frames, which
    // shows up here as the one entry that is not `old / 1 frames`.
    expect(everyWrite().filter((write) => write !== 'old / 1 frames')).toEqual([])
    expect(everyWrite().length).toBeGreaterThan(0)
  })

  it('leaves the coach looking at their own board, and says why', async () => {
    await openBoard()

    mockApi.createBoard.mockRejectedValue(new AppError('The board could not be created.'))
    await pressNew()

    // Read before the timers run out, since a toast only lives four seconds.
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'The board could not be created.',
    )

    await waitOutEveryTimer()

    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(useBoardStore.getState().boardId).toBe('old')
    expect(useBoardsStore.getState().currentId).toBe('old')
  })

  it('holds the open board untouched while a slow create is still in flight', async () => {
    await openBoard()

    let settle: (value: { board: BoardSummary }) => void = () => {}
    mockApi.createBoard.mockReturnValue(
      new Promise<{ board: BoardSummary }>((resolve) => {
        settle = resolve
      }),
    )

    await pressNew()

    // Far past the 800ms debounce, with the create still unanswered. This is
    // the window the old code wrote a blank board in without anything failing
    // at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(everyWrite().filter((write) => write !== 'old / 1 frames')).toEqual([])

    // Now the server answers, and only now does the board on screen change.
    await act(async () => {
      settle({ board: NEW })
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(useBoardsStore.getState().currentId).toBe('new')
    expect(useBoardStore.getState().boardId).toBe('new')
    // Whatever went to the new board, nothing blank ever went to the old one.
    expect(everyWrite().filter((write) => write.startsWith('old'))).toEqual(['old / 1 frames'])
  })
})

/**
 * The guard behind the fix, on its own.
 *
 * The picker no longer creates the situation, but the situation is not the
 * picker's to be the only one to avoid: any future path that swaps the board
 * store's contents without the open board changing recreates it exactly.
 */
describe('the save path', () => {
  it('refuses to write contents that belong to no board', async () => {
    useBoardsStore.setState({ boards: [OLD], currentId: 'old' })
    useBoardStore.getState().initDefaultBoard()

    expect(await flushSave('old')).toBe(false)
    expect(mockApi.saveBoard).not.toHaveBeenCalled()
  })

  it('refuses to write one board over another', async () => {
    useBoardsStore.setState({ boards: [OLD, NEW], currentId: 'old' })
    useBoardStore.getState().initDefaultBoard('new')
    // Holding a board means holding which state of it these contents came from,
    // not only its id: every write states the base it was made on, and contents
    // whose base is unknown cannot state one. `loadBoard` sets the two together;
    // this stands in for it, so the accepted write below is testing the id guard
    // rather than tripping over the other one.
    useBoardStore.getState().setBoardId('new', 1)

    expect(await flushSave('old')).toBe(false)
    expect(mockApi.saveBoard).not.toHaveBeenCalled()

    expect(await flushSave('new')).toBe(true)
    expect(mockApi.saveBoard).toHaveBeenCalledTimes(1)
    expect(mockApi.saveBoard.mock.calls[0][0]).toBe('new')
  })
})

/**
 * An edit that holds its undo step open still has to be saved.
 *
 * The inspector's name and number fields defer the history push so a run of
 * keystrokes is one undo step rather than one per character. Autosave hangs off
 * the board store's subscription and the identity of the token array, not off
 * the history, and this asserts that it stays that way: the typed value has to
 * reach the server without anybody committing anything, because nothing
 * guarantees a coach blurs the field before closing the tab.
 */
describe('an edit that defers its undo step', () => {
  it('still autosaves, carrying what was typed', async () => {
    await openBoard()
    const id = useBoardStore.getState().tokens.find((t) => t.type === 'player')!.id
    mockApi.saveBoard.mockClear()

    act(() => {
      for (const label of ['K', 'Ka', 'Kan', 'Kant', 'Kante']) {
        useBoardStore.getState().updateToken(id, { label }, true)
      }
    })
    await waitOutEveryTimer()

    expect(mockApi.saveBoard).toHaveBeenCalled()
    const written = mockApi.saveBoard.mock.calls.at(-1)![2] as PersistedBoard
    expect(written.tokens.find((t) => t.id === id)?.label).toBe('Kante')

    // Saved, and still nothing in history until the run is committed.
    expect(useBoardStore.getState().history.past).toHaveLength(0)
  })

  /**
   * The notes pad is the same rule on a field that is a string rather than an
   * array, which is the one way it could have been left out.
   *
   * `persistableChanged` compares the other seven by reference, because every
   * action replaces the array or object outright. Notes are compared by value,
   * and a field omitted from that list is written into every save and triggers
   * none — a pad that keeps what you typed only if you happen to move a chip
   * afterwards, and forgets it if you do not.
   */
  it('saves the notes pad without waiting for anything else to change', async () => {
    await openBoard()
    // Everything the open itself scheduled has to have run *before* the counter
    // is cleared, or a save that was already on its way would stand in for the
    // one the notes are supposed to cause — and this test would pass with the
    // notes left out of `persistableChanged` entirely, which is exactly the
    // omission it exists to catch. Confirmed by removing that clause: with the
    // wait, this fails; without it, it does not.
    await waitOutEveryTimer()
    mockApi.saveBoard.mockClear()

    act(() => {
      for (const notes of ['P', 'Pr', 'Press high']) {
        useBoardStore.getState().setNotes(notes, true)
      }
    })
    await waitOutEveryTimer()

    expect(mockApi.saveBoard).toHaveBeenCalled()
    const written = mockApi.saveBoard.mock.calls.at(-1)![2] as PersistedBoard
    expect(written.notes).toBe('Press high')
  })
})

/**
 * The same class, reached without anyone clicking anything.
 *
 * A stored board that fails `isPersistedBoard` is replaced on screen by a blank
 * default. That blank used to be adopted as the open board, so the very next
 * autosave beat wrote it over the row that failed to parse: a board that this
 * version could not read became a board that no version can, on load, with no
 * user action at all.
 */
describe('a stored board this version cannot read', () => {
  /**
   * A truncated row: the current version, and most of the board missing.
   *
   * It used to be `{ version: 1, ... }`, which read as "an old board" and stopped
   * being true the day the guard learned to bring old boards forward. These tests
   * are about the dead end rather than about versions, so the payload says so on
   * its face: unreadable because half of it is not there.
   */
  const unreadable = { version: SCHEMA_VERSION, teams: [], tokens: [] }

  /** The board list, and which of its boards come back readable. */
  const listing = (boards: BoardSummary[], readable: (id: string) => boolean) => {
    mockApi.listBoards.mockResolvedValue({ boards, nextCursor: null })
    mockApi.getBoard.mockImplementation(async (id: string) => ({
      board: {
        ...summary(id, boards.find((b) => b.id === id)?.name ?? id),
        data: readable(id) ? boardWithWork() : unreadable,
        generation: 1,
      },
    }))
  }

  /** Let the load, and any load it starts in its place, settle. */
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('never writes the blank stand-in over the stored row', async () => {
    mockApi.getBoard.mockResolvedValue({ board: { ...OLD, data: unreadable } })

    await openBoard()

    expect(useBoardStore.getState().boardId).toBeNull()
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'That board could not be opened. Your saved copy is untouched, and this blank one is not being saved.',
    )

    // Work on the stand-in, which is what a coach who did not read the toast
    // would do, and which is what schedules the write.
    act(() => {
      useBoardStore.getState().addFrame()
    })
    await waitOutEveryTimer()

    expect(mockApi.saveBoard).not.toHaveBeenCalled()
  })

  /**
   * The indicator is the only part of this that is still on screen a minute
   * later.
   *
   * The toast is right and it is not enough: four seconds of it, against a
   * session's worth of an indicator reading "Ready" over a board where every
   * single write is refused. "Ready" is what a working board rests at, so the
   * dead end and the healthy board were indistinguishable from the one place a
   * coach looks to ask the question.
   */
  it('never reads "Ready" while every write would be refused', async () => {
    mockApi.getBoard.mockResolvedValue({ board: { ...OLD, data: unreadable } })

    await openBoard()

    expect(screen.queryByText('Ready')).toBeNull()
    expect(screen.getByText('Not saving')).toBeTruthy()

    // And it is not merely pessimistic: the write really is refused.
    expect(await flushSave('old')).toBe(false)

    // Still true after the toast has come and gone.
    await waitOutEveryTimer()
    expect(screen.queryByText('Ready')).toBeNull()
    expect(screen.getByText('Not saving')).toBeTruthy()
  })

  /**
   * Better than telling them: put them somewhere their work is kept.
   *
   * This is what a board id the server has never heard of already does, so the
   * two ways a board can fail to open now end in the same place.
   */
  it('opens a board that does save instead, when there is one', async () => {
    listing([OLD, NEW], (id) => id !== 'old')

    await openBoard()
    await settle()

    expect(useBoardsStore.getState().currentId).toBe('new')
    expect(useBoardStore.getState().boardId).toBe('new')
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'That board could not be opened, so "Board 2" is open instead. Your saved copy is untouched.',
    )
    // Nothing was blanked on the way: the coach lands on a real board.
    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(screen.queryByText('Not saving')).toBeNull()

    act(() => {
      useBoardStore.getState().addFrame()
    })
    await waitOutEveryTimer()

    // Work reaches the server, and nothing was written over the board that
    // could not be read.
    expect(everyWrite()).toEqual(['new / 2 frames'])
    expect(useBoardsStore.getState().saveState).toBe('saved')
  })

  /**
   * Two of them, and "open something else" would be a loop rather than a fix.
   *
   * Each turn of it is a request, so this has to stop on its own rather than on
   * the coach closing the tab.
   */
  it('stops, and says so, when there is no readable board to move to', async () => {
    listing([OLD, NEW], () => false)

    await openBoard()
    await settle()
    await waitOutEveryTimer()

    // One attempt each, not one attempt each forever.
    expect(mockApi.getBoard.mock.calls.map((call) => call[0])).toEqual(['old', 'new'])
    expect(screen.getByText('Not saving')).toBeTruthy()
    expect(mockApi.saveBoard).not.toHaveBeenCalled()
  })

  /**
   * And it stops saying it once it stops being true, or the indicator is only
   * honest in one direction.
   */
  it('goes back to normal once a board that saves is opened', async () => {
    listing([OLD], (id) => id !== 'old')

    await openBoard()
    expect(screen.getByText('Not saving')).toBeTruthy()

    // The way out of a dead end with nothing else in the list: start a board.
    await pressNew()
    await waitOutEveryTimer()

    expect(useBoardsStore.getState().currentId).toBe('new')
    expect(screen.queryByText('Not saving')).toBeNull()
    expect(useBoardsStore.getState().saveState).toBe('saved')
  })
})

/**
 * The one case that must keep showing nothing at all.
 *
 * A guest is told by the account menu, right beside the button that fixes it,
 * and the two of them side by side said "Not saving" twice.
 */
describe('the indicator for a signed-out guest', () => {
  it('renders nothing', () => {
    useAuthStore.setState({ user: null, ready: true })
    useBoardsStore.setState({ saveState: 'blocked' })

    const { container } = render(<SaveStatus />)
    expect(container.innerHTML).toBe('')
  })
})
