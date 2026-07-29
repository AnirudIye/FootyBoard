import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useRealtime } from './useRealtime'
import SaveStatus from '../components/board/SaveStatus'
import { api } from '../lib/api'
import { flushSave, loadBoard } from '../lib/boardSync'
import { ConflictError } from '../lib/errors'
import type { PersistedBoard } from '../lib/persistence'
import { useAuthStore } from '../store/authStore'
import { useBoardsStore } from '../store/boardsStore'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'
import { useRealtimeStore } from '../store/realtimeStore'
import { useToastStore } from '../store/toastStore'

/**
 * What the board says about itself once it stops being in step with the room.
 *
 * Two defects, one condition. Both ended with the top bar reporting a healthy
 * board over one that nothing would be written to, which is the single question
 * a coach uses that indicator to answer.
 *
 * `blocked` is the state that already means this, and it means it for the right
 * reason: it is a standing condition rather than the result of an attempt, and
 * it lasts until a board opens successfully instead of until the next write. So
 * the whole of both fixes is which state gets left behind, and that is only
 * worth asserting through the component a person actually reads. `SaveStatus`
 * is rendered here for the same reason `useAutosave.test.tsx` renders it: the
 * indicator and the thing that decides what it says are two files apart, and
 * the gap is where both of these lived.
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

const mockApi = api as unknown as { getBoard: Mock; saveBoard: Mock }

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1

  readyState = FakeSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  serverClosed(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  serverSent(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const latest = () => FakeSocket.instances.at(-1)!

function Harness() {
  useRealtime()
  return <SaveStatus />
}

/** Signed in, with a board open, which is the only state that opens a room. */
const openRoom = async () => {
  useAuthStore.setState({ email: 'coach@example.com', ready: true })
  useBoardsStore.setState({ currentId: 'board-1', saveState: 'saved' })
  render(<Harness />)
  await act(async () => {
    latest().onopen?.()
  })
}

/**
 * Deliver a server message and let it be handled all the way through.
 *
 * `useRealtime` chains every message onto one promise, and the two branches
 * this file cares about await a REST round trip inside that chain, so the work
 * lands several microtask hops after the frame arrives. Draining a fixed number
 * of turns keeps the test deterministic rather than waiting on a clock.
 */
const serverSays = async (message: unknown) => {
  await act(async () => {
    latest().serverSent(message)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

/** The board this client is holding, with something in it worth not losing. */
const boardWithWork = (): PersistedBoard => ({
  ...defaultPersistedBoard(),
  frames: [{ id: 'f1', label: '1', tokens: {} }],
})

/**
 * Signed in, holding a board that really loaded, in a room.
 *
 * The load goes through the real `loadBoard` rather than being poked into the
 * store, because what these tests turn on is the board store holding this exact
 * id, and a test that set that up by hand would not notice if the loader
 * stopped doing it.
 */
const holdingBoardInRoom = async () => {
  // Every read carries the generation the board is on, which is the base a later
  // write states. A fixture without one describes a response the server cannot
  // send, and `loadBoard` refuses it rather than opening a board it could never
  // save to.
  mockApi.getBoard.mockResolvedValue({
    board: { id: 'board-1', data: boardWithWork(), generation: 1 },
  })
  useAuthStore.setState({ email: 'coach@example.com', ready: true })
  useBoardsStore.setState({ currentId: 'board-1', saveState: 'saved' })
  await act(async () => {
    expect(await loadBoard('board-1', 'open')).toBe(true)
  })
  render(<Harness />)
  await act(async () => {
    latest().onopen?.()
  })
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.clearAllMocks()
  mockApi.saveBoard.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useRealtimeStore.getState().reset()
  useBoardsStore.setState({ saveState: 'idle', currentId: null })
  useBoardStore.getState().initDefaultBoard()
  useAuthStore.setState({ email: null })
  useToastStore.setState({ toasts: [] })
})

describe('a room that refuses this client', () => {
  it('stops the indicator claiming the board is saved when the session is revoked', async () => {
    await openRoom()
    expect(screen.getByText('Saved')).toBeTruthy()

    await act(async () => {
      latest().serverClosed(4401)
    })

    // "Saved" over a session that has been destroyed is the whole defect: every
    // write from here answers 401, and the top bar was reporting a healthy
    // board for the rest of the session.
    expect(useBoardsStore.getState().saveState).toBe('blocked')
    expect(screen.getByText('Not saving')).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
    expect(useToastStore.getState().toasts[0]?.message).toContain('session has ended')
  })

  it('says the same thing when the board stops being shared', async () => {
    await openRoom()

    await act(async () => {
      latest().serverClosed(4403)
    })

    // The same standing truth by a different route: `PUT` on a board that is no
    // longer shared with you is refused just as surely as one made without a
    // session, so the indicator must not rest on "Saved" for that either.
    expect(useBoardsStore.getState().saveState).toBe('blocked')
    expect(screen.getByText('Not saving')).toBeTruthy()
  })

  it('leaves the indicator alone when the connection merely drops', async () => {
    await openRoom()

    await act(async () => {
      latest().serverClosed(1006)
    })

    // Saving goes over REST and works perfectly well with no room at all, so a
    // transport failure is not a reason to tell anybody their work is not being
    // written. It reconnects instead.
    expect(useBoardsStore.getState().saveState).toBe('saved')
    expect(screen.getByText('Saved')).toBeTruthy()
  })
})

/**
 * A whole-board change from a peer, re-read, and unreadable.
 *
 * This is not an exotic path. Undo, redo, reset and changing format all rewrite
 * everything at once, far past the payload cap, so none of them travels as an
 * op: the originator saves and broadcasts `replaced`, and every peer re-reads
 * over REST. Every one of those actions, in every shared room, lands here.
 *
 * `loadBoard` answers false when the row fails `isPersistedBoard` and leaves the
 * store exactly as it found it, which is right. The defect was that the answer
 * was thrown away, so a client whose re-read failed carried on showing the board
 * from *before* the peer replaced it, with the indicator still reading "Saved"
 * and its own autosave ready to write those stale contents back over a newer
 * row. Nothing was said in the interface, in a toast, or in the console: the
 * only symptom was one person's board quietly no longer matching the room's.
 *
 * The payload used here is the shape of the one unreadable row in the dev
 * database, which is literally `{"v":1}`.
 */
describe('a re-read that will not parse', () => {
  const UNREADABLE = { v: 1 }

  /** The peer saved a board this version cannot read, and said so. */
  const peerReplacedTheBoard = async () => {
    // Generation 2: the peer replaced the whole board, which is what moves it.
    mockApi.getBoard.mockResolvedValue({
      board: { id: 'board-1', data: UNREADABLE, generation: 2 },
    })
    await serverSays({ type: 'replaced', peerId: 'peer-2' })
  }

  it('stops the indicator claiming the board is saved after a `replaced`', async () => {
    await holdingBoardInRoom()
    expect(screen.getByText('Saved')).toBeTruthy()

    await peerReplacedTheBoard()

    // The contents on screen are the ones from before the peer's change, which
    // is `loadBoard` correctly refusing to touch the store. What must not
    // survive with them is the claim that any of this is in step or saved.
    expect(useBoardStore.getState().frames).toHaveLength(1)
    expect(useBoardsStore.getState().saveState).toBe('blocked')
    expect(screen.getByText('Not saving')).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'This board changed and could not be read, so what is on screen is out of date and is not being saved. Your saved copy is untouched.',
    )
  })

  /**
   * And it is not merely pessimistic.
   *
   * "Not saving" over a board that would in fact save is its own lie, and it
   * would not even last: the next write sets `saved` and the indicator goes
   * back to reporting a healthy board 800ms later. Worse than the indicator is
   * what the write would carry, which is contents from before the peer's change
   * written over a row holding something newer than them.
   */
  it('refuses to write the stale contents back over the newer row', async () => {
    await holdingBoardInRoom()
    await peerReplacedTheBoard()

    expect(await flushSave('board-1')).toBe(false)
    expect(mockApi.saveBoard).not.toHaveBeenCalled()
    expect(useBoardsStore.getState().saveState).toBe('blocked')
  })

  /**
   * The same dead end reached by the other branch.
   *
   * A lock arriving means the server has already dropped whatever this client
   * edited in the moments before it, so the client re-reads to get back to the
   * truth. If the truth will not parse it is left holding edits nobody accepted,
   * on a board it can no longer read, which is the case above by a different
   * route and has to end in the same place.
   */
  it('says the same thing when the lock branch re-reads and fails', async () => {
    await holdingBoardInRoom()

    // A member, not the owner: an owner is never locked out by their own lock,
    // and it is being locked out that triggers the re-read.
    await serverSays({ type: 'welcome', peerId: 'me', role: 'member', locked: false, peers: [] })

    mockApi.getBoard.mockResolvedValue({
      board: { id: 'board-1', data: UNREADABLE, generation: 2 },
    })
    await serverSays({ type: 'lock', locked: true, peerId: 'owner' })

    expect(useBoardsStore.getState().saveState).toBe('blocked')
    expect(screen.getByText('Not saving')).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
    expect(await flushSave('board-1')).toBe(false)
    expect(mockApi.saveBoard).not.toHaveBeenCalled()
  })

  /**
   * Nor does it go on telling the room about a board the room replaced.
   *
   * Ops carry outcomes, not intents, so a peer applies "token t7 is now here"
   * without re-deriving anything. Positions from a board that has been replaced
   * are therefore not stale on this screen only: every peer would take them as
   * current. A client that already knows it is out of step has nothing to say.
   */
  it('stops emitting once it is working from contents nobody else has', async () => {
    await holdingBoardInRoom()

    // It really does speak while it holds the board, or the assertion below
    // would pass just as well against a client that never spoke at all.
    act(() => {
      useBoardStore.getState().addFrame()
    })
    const spoke = latest().sent.length
    expect(spoke).toBeGreaterThan(0)

    await peerReplacedTheBoard()

    act(() => {
      useBoardStore.getState().addFrame()
    })
    expect(latest().sent.length).toBe(spoke)
  })
})

/**
 * A whole-board change the room got to first.
 *
 * This is gap 10 from the originating side. Undo, redo, reset and a format
 * change all save and then broadcast `replaced`, and the server now refuses that
 * save if somebody else replaced the board in the meantime. What must not happen
 * then is the announcement going out anyway: `replaced` tells every peer to
 * re-read, and a peer that re-reads on the back of a write that never landed is
 * being pointed at somebody else's board and told it is this client's change.
 *
 * The suppression itself is not new — `sendReplaced` has always waited on the
 * write — but the reason is, and this is the seam the original defect lived in,
 * so it is worth holding here rather than only in `boardSync.test.ts`.
 */
describe('a whole-board change the room got to first', () => {
  const raced = async () => {
    await holdingBoardInRoom()
    mockApi.saveBoard.mockRejectedValue(new ConflictError('Changed elsewhere.', 2))
    mockApi.getBoard.mockResolvedValue({
      board: { id: 'board-1', data: theirs, generation: 2 },
    })

    // A reset rewrites everything at once, which is exactly the class of change
    // that saves and then announces itself.
    await act(async () => {
      useBoardStore.getState().resetBoardAction()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
  }

  const theirs: PersistedBoard = {
    ...defaultPersistedBoard(),
    frames: [{ id: 'theirs', label: 'theirs', tokens: {} }],
  }

  const announcements = () =>
    latest().sent.filter((raw) => JSON.parse(raw).type === 'replaced')

  it('does not tell the room to re-read a write that was refused', async () => {
    await raced()

    expect(announcements()).toHaveLength(0)
  })

  it('takes on the board that won instead', async () => {
    await raced()

    // And converges rather than sitting on a reset nobody accepted, which is
    // the divergence the whole mechanism exists to stop.
    expect(useBoardStore.getState().frames.map((f) => f.id)).toEqual(['theirs'])
    expect(screen.queryByText('Not saving')).toBeNull()
  })
})

/**
 * Two branches that re-read, and the order they are allowed to settle in.
 *
 * `replaced` and `lock` both answer by pulling the whole board back over REST,
 * and both of those reads change what is on screen. Which means the order they
 * come back in decides what the client is left holding, and a REST round trip
 * does not come back in the order it went out: two reads in flight settle in
 * whichever order the network hands them over, so the *slower* one wins rather
 * than the newer one.
 *
 * That is the race the promise chain in `useRealtime` was built to close, and it
 * only closes it for the branches that are actually on it. `lock` was firing its
 * re-read off to one side with `void`, so a `lock` arriving just before a
 * `replaced` could have its read overtaken and then land on top of it, leaving
 * this client on the older of the two boards with nothing due to correct it.
 *
 * Both tests here drive the reads by hand rather than by a clock: the whole
 * question is what happens between the two, and a timer would only make it
 * likely rather than certain.
 */
describe('re-reads settle in the order the messages arrived', () => {
  const taggedBoard = (tag: string): PersistedBoard => ({
    ...defaultPersistedBoard(),
    frames: [{ id: tag, label: tag, tokens: {} }],
  })

  /** Which board each read answers with, indexed by the order reads are issued. */
  const ANSWERS = [taggedBoard('from-lock'), taggedBoard('from-replaced')]

  const heldTag = () => useBoardStore.getState().frames[0]?.id

  /**
   * A member in a room, with every later `getBoard` left hanging.
   *
   * A member rather than the owner because an owner is never locked out by
   * their own lock, and it is being locked out that sets off the re-read.
   */
  const memberWithReadsHeldOpen = async () => {
    await holdingBoardInRoom()
    await serverSays({ type: 'welcome', peerId: 'me', role: 'member', locked: false, peers: [] })

    /**
     * Both reads answer on the same generation, and that is deliberate.
     *
     * `loadBoard` refuses to adopt a board older than the one it is holding, and
     * that guard would decide this test on its own if the two answers carried
     * different generations — which would leave the chain untested while the
     * test went on claiming to test it. Equal generations make the guard
     * neutral, so arrival order is once again the only thing that decides.
     */
    const pending: Array<(data: PersistedBoard) => void> = []
    mockApi.getBoard.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push((data) => resolve({ board: { id: 'board-1', data, generation: 1 } }))
        }),
    )
    return pending
  }

  /** Put a frame on the wire and let everything it can reach run. */
  const deliver = async (message: unknown) => {
    await act(async () => {
      latest().serverSent(message)
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
  }

  /** A lock, then a replaced, in that order and with neither read answered. */
  const lockThenReplaced = async (pending: unknown[]) => {
    await deliver({ type: 'lock', locked: true, peerId: 'owner' })
    await deliver({ type: 'replaced', peerId: 'owner' })
    return pending
  }

  it('does not start a second re-read while the first is still in flight', async () => {
    const pending = await memberWithReadsHeldOpen()
    await lockThenReplaced(pending)

    // The chain is the whole mechanism, so it is worth asserting directly
    // rather than only through its effect. One read outstanding means the
    // `replaced` branch has not run yet, and a read that has not been issued
    // cannot overtake anything.
    expect(pending).toHaveLength(1)
  })

  it('leaves the later message in place when the earlier read comes back last', async () => {
    const pending = await memberWithReadsHeldOpen()
    await lockThenReplaced(pending)

    // Answer whichever read was issued most recently, first. With the chain
    // intact there is only ever one outstanding, so this is simply arrival
    // order and nothing is being contrived; with a read sitting outside the
    // chain there are two, and this is the network handing back the later
    // message's read first. Each read answers with the board its own branch
    // asked for, so what is left on screen is purely a question of order.
    const settled = new Set<number>()
    for (;;) {
      let i = pending.length - 1
      while (i >= 0 && settled.has(i)) i -= 1
      if (i < 0) break
      settled.add(i)
      await act(async () => {
        pending[i](ANSWERS[i])
        for (let n = 0; n < 10; n += 1) await Promise.resolve()
      })
    }

    // `replaced` arrived second, so `replaced` is what this client is holding.
    // The other way round is one client quietly on a board the room has
    // already moved off, which is the failure the chain exists to prevent.
    expect(heldTag()).toBe('from-replaced')
  })
})
