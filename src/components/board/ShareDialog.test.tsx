import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { api } from '../../lib/api'
import { AppError } from '../../lib/errors'
import ShareDialog from './ShareDialog'
import { useAuthStore } from '../../store/authStore'
import { useBoardsStore } from '../../store/boardsStore'
import { useRealtimeStore } from '../../store/realtimeStore'
import { useToastStore } from '../../store/toastStore'

/**
 * A signed-in account, as the store now holds it.
 *
 * The store used to keep `email: string | null` and use it as the signed-in flag
 * too. An account can exist without an address now — a guest admitted by a join
 * code — so the flag is the presence of a user and the address is a field on it.
 */
const signedInUser = { id: 'u1', email: 'coach@example.test', displayName: null, createdAt: '2026-07-01T00:00:00.000Z', isGuest: false, twoFactorEnabled: false }

/**
 * The panel that hands out a one-time credential.
 *
 * `POST /share` is the only moment the link's plaintext exists outside the
 * server, which stores a hash of it. Anything that drops it between that reply
 * and the screen destroys it: `GET /share` deliberately never returns it, so
 * the owner's only route to a working link is rotating, which revokes the one
 * people may already be holding. That is the defect these are mostly about, and
 * it is why the assertions are about what is on screen rather than about which
 * calls were made.
 *
 * The other half is the rule the handoff writes down under "Things that will
 * bite": nothing on this panel may be latched from a mirror that no reply
 * updates. The lock has been broken that way once already.
 */

vi.mock('../../lib/api', () => ({
  api: {
    getShare: vi.fn(),
    createShare: vi.fn(),
    refreshCode: vi.fn(),
    revokeShare: vi.fn(),
    listMembers: vi.fn(),
    removeMember: vi.fn(),
    setBoardLock: vi.fn(),
    setAnonymousPresence: vi.fn(),
  },
}))

const mockApi = api as unknown as {
  getShare: Mock
  createShare: Mock
  refreshCode: Mock
  revokeShare: Mock
  listMembers: Mock
  setBoardLock: Mock
  setAnonymousPresence: Mock
}

const BOARD = {
  id: 'b1',
  name: 'Real board',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  role: 'owner' as const,
  membersCanEdit: true,
}

const TOKEN = 'tok_abcdefghijklmnop'
const twelveHours = () => Date.now() + 12 * 3600_000

/**
 * Enough of the server to be worth reading against.
 *
 * `GET /share` answers from what `POST /share` wrote, minus the token, which is
 * the single behaviour the panel has to be correct about. A mock that answered
 * a fixed object could not tell the fixed panel from the broken one.
 */
let stored: { id: string; code: string; codeExpiresAt: number } | null = null

const rotateTo = (id: string, code: string) => {
  stored = { id, code, codeExpiresAt: twelveHours() }
}

const openPanel = async () => {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Share' }), { button: 0 })
  })
}

const closePanel = async () => {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Escape' })
  })
}

const press = async (target: HTMLElement | string) => {
  const el = typeof target === 'string' ? screen.getByRole('button', { name: target }) : target
  await act(async () => {
    fireEvent.click(el)
  })
}

const switchNamed = (name: string) => screen.getByRole('switch', { name })
const linkField = () => screen.queryByDisplayValue(new RegExp(TOKEN)) as HTMLInputElement | null

beforeEach(() => {
  vi.clearAllMocks()
  stored = null

  mockApi.getShare.mockImplementation(async () => ({
    share: stored ? { ...stored, createdAt: '2026-07-28T00:00:00.000Z' } : null,
    anonymousPresence: false,
  }))
  mockApi.listMembers.mockResolvedValue({ members: [] })
  mockApi.createShare.mockImplementation(async () => {
    rotateTo('share-1', 'QWERTY')
    return { share: { ...stored!, token: TOKEN, createdAt: '2026-07-28T00:00:00.000Z' } }
  })
  mockApi.refreshCode.mockImplementation(async () => {
    stored = { ...stored!, code: 'ZXCVBN', codeExpiresAt: twelveHours() }
    return { share: stored }
  })
  mockApi.revokeShare.mockImplementation(async () => {
    stored = null
  })
  mockApi.setBoardLock.mockImplementation(async (_id: string, locked: boolean) => ({ locked }))
  mockApi.setAnonymousPresence.mockImplementation(async (_id: string, anonymous: boolean) => ({
    anonymousPresence: anonymous,
  }))

  useAuthStore.setState({ user: signedInUser, ready: true })
  useBoardsStore.setState({ boards: [BOARD], currentId: 'b1' })
  useRealtimeStore.getState().reset()
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, ready: false })
  useBoardsStore.setState({ boards: [], currentId: null })
  useRealtimeStore.getState().reset()
})

describe('the link a share hands out exactly once', () => {
  it('is on screen the moment the server hands it over', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')

    expect(linkField()!.value).toBe(
      `http://localhost:3000/board?board=b1&share=${TOKEN}`,
    )
    expect(screen.getByText('QWERTY')).toBeInTheDocument()
  })

  /**
   * The defect this file exists for.
   *
   * Reading the code out and then coming back for the link is the flow the
   * panel is laid out for, and closing it used to destroy the credential. The
   * server will not say it again, so the only way back was rotating, which
   * revokes the link anybody may already have followed.
   */
  it('survives the panel being closed and opened again', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')
    expect(linkField()).not.toBeNull()

    await closePanel()
    await openPanel()

    expect(linkField()!.value).toContain(`share=${TOKEN}`)
    // And the copy that stands in for it is not being shown over the top of a
    // link the owner can still see.
    expect(screen.queryByText(/no longer has it/)).toBeNull()
  })

  /** A fresh code is a separate endpoint precisely so the link keeps working. */
  it('survives a new code being issued', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')
    await press('New code')

    expect(screen.getByText('ZXCVBN')).toBeInTheDocument()
    expect(linkField()!.value).toContain(`share=${TOKEN}`)
  })

  /**
   * The other side of keeping it: a link that has stopped working must stop
   * being offered. Both cases are decided by what the server says the live
   * share is, not by the panel remembering what it did.
   */
  it('is retired when the share is rotated somewhere else', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')

    // Another tab, or another device, rotated it. Same board, new share.
    rotateTo('share-2', 'MNBVCX')
    await closePanel()
    await openPanel()

    expect(linkField()).toBeNull()
    expect(screen.getByText('MNBVCX')).toBeInTheDocument()
    expect(screen.getByText(/no longer has it/)).toBeInTheDocument()
  })

  it('is retired when sharing is turned off', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')
    await press('Stop sharing')

    expect(linkField()).toBeNull()
    expect(screen.getByRole('button', { name: 'Turn on sharing' })).toBeInTheDocument()
  })

  /** Nothing read for one board may be shown against another. */
  it('is not carried across to another board', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')
    await closePanel()

    await act(async () => {
      useBoardsStore.setState({
        boards: [BOARD, { ...BOARD, id: 'b2', name: 'Other board' }],
        currentId: 'b2',
      })
    })
    stored = null
    await openPanel()

    expect(linkField()).toBeNull()
    expect(screen.queryByText('QWERTY')).toBeNull()
  })
})

/**
 * Rotating revokes a credential other people may be holding, and there is no
 * list of who they are.
 */
describe('rotating the link', () => {
  it('asks before it breaks the link anyone already has', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')
    mockApi.createShare.mockClear()

    await press('New link too')
    expect(mockApi.createShare).not.toHaveBeenCalled()

    await press('Yes, break the old link')
    expect(mockApi.createShare).toHaveBeenCalledTimes(1)
  })

  it('does not ask the first time, when there is nothing to break', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press('Turn on sharing')

    expect(mockApi.createShare).toHaveBeenCalledTimes(1)
  })
})

/**
 * Both switches, against the rule in the handoff: read the server's answer,
 * never a value latched when the panel opened.
 */
describe('the instructor mode switch', () => {
  it('shows what the reply says the board is, not what was asked for', async () => {
    // The write landed on a board that is not locked. Whatever the reason, the
    // switch has to say what the board is.
    mockApi.setBoardLock.mockResolvedValue({ locked: false })

    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Instructor mode'))

    expect(mockApi.setBoardLock).toHaveBeenCalledWith('b1', true)
    expect(switchNamed('Instructor mode')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Everyone on this board can move things.')).toBeInTheDocument()
  })

  it('turns on, and says so, when the server agrees', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Instructor mode'))

    expect(switchNamed('Instructor mode')).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByText('Only you can move things. Everyone else is watching.'),
    ).toBeInTheDocument()
    expect(useRealtimeStore.getState().boardLocked).toBe(true)
  })

  it('goes back where it was when the write fails', async () => {
    mockApi.setBoardLock.mockRejectedValue(new AppError('Could not switch instructor mode.'))

    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Instructor mode'))

    expect(switchNamed('Instructor mode')).toHaveAttribute('aria-checked', 'false')
    expect(useRealtimeStore.getState().boardLocked).toBe(false)
  })

  /**
   * The documented trap, both sides of it.
   *
   * Once the socket has spoken, `boardLocked` is the truth and the board list's
   * `membersCanEdit` is a mirror nothing updates. Before it has spoken,
   * `boardLocked` is its own default of `false` and reading it tells the same
   * lie the other way round, showing a locked board as unlocked on every reload
   * and for as long as `/ws` is unreachable. `peerId` is the signal.
   */
  it('reads the socket once it has spoken, over the stale list value', async () => {
    useBoardsStore.setState({ boards: [{ ...BOARD, membersCanEdit: true }], currentId: 'b1' })
    act(() => {
      useRealtimeStore.getState().welcome('peer-1', 'owner', true, [])
    })

    render(<ShareDialog />)
    await openPanel()

    expect(switchNamed('Instructor mode')).toHaveAttribute('aria-checked', 'true')
  })

  it('reads the list while the socket has said nothing, rather than its default', async () => {
    useBoardsStore.setState({ boards: [{ ...BOARD, membersCanEdit: false }], currentId: 'b1' })
    expect(useRealtimeStore.getState().peerId).toBeNull()
    expect(useRealtimeStore.getState().boardLocked).toBe(false)

    render(<ShareDialog />)
    await openPanel()

    expect(switchNamed('Instructor mode')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('the anonymous guests switch', () => {
  it('shows what the reply says the board is, not what was asked for', async () => {
    mockApi.setAnonymousPresence.mockResolvedValue({ anonymousPresence: false })

    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Anonymous guests'))

    expect(mockApi.setAnonymousPresence).toHaveBeenCalledWith('b1', true)
    expect(switchNamed('Anonymous guests')).toHaveAttribute('aria-checked', 'false')
  })

  it('turns on, and says so, when the server agrees', async () => {
    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Anonymous guests'))

    expect(switchNamed('Anonymous guests')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/Anonymous Quokka/)).toBeInTheDocument()
  })

  it('is read from the board on open, not assumed', async () => {
    mockApi.getShare.mockResolvedValue({ share: null, anonymousPresence: true })

    render(<ShareDialog />)
    await openPanel()

    expect(switchNamed('Anonymous guests')).toHaveAttribute('aria-checked', 'true')
  })

  it('goes back where it was when the write fails', async () => {
    mockApi.setAnonymousPresence.mockRejectedValue(new AppError('Nope.'))

    render(<ShareDialog />)
    await openPanel()
    await press(switchNamed('Anonymous guests'))

    expect(switchNamed('Anonymous guests')).toHaveAttribute('aria-checked', 'false')
  })
})

/**
 * Who is on this board, which is the owner's own list rather than the room's.
 *
 * Every row used to draw `email`, and a guest admitted by a join code has none:
 * the owner got a blank row with a Remove button beside it, one per guest, all
 * identical. The endpoint sends a `displayName` that always says something now —
 * the address for anybody who has one, because who has access is the owner's to
 * know, and a chosen or generated name for anybody who does not — and this is the
 * half that draws it.
 */
describe('the list of who is on this board', () => {
  const MEMBERS = [
    {
      id: 'm1',
      email: 'assistant@example.test',
      displayName: 'assistant@example.test',
      joinedAt: '2026-07-02T00:00:00.000Z',
    },
    {
      id: 'm2',
      email: 'analyst@example.test',
      displayName: 'Nia Adeyemi',
      joinedAt: '2026-07-03T00:00:00.000Z',
    },
    {
      id: 'g1',
      email: null,
      displayName: 'Anonymous Marmot',
      joinedAt: '2026-07-04T00:00:00.000Z',
    },
  ]

  const withMembers = async () => {
    mockApi.listMembers.mockResolvedValue({ members: MEMBERS })
    render(<ShareDialog />)
    await openPanel()
  }

  it('draws a name for everybody, guest included', async () => {
    await withMembers()

    // The address for the two accounts that have one, because the owner is
    // entitled to know who has access to their board.
    expect(screen.getByText('assistant@example.test')).toBeInTheDocument()
    // The chosen name where there is one, which is what the room shows too.
    expect(screen.getByText('Nia Adeyemi')).toBeInTheDocument()
    // And the guest, who has no address at all. This was the blank row.
    expect(screen.getByText('Anonymous Marmot')).toBeInTheDocument()
  })

  it('names the guest in the toast that says they were removed', async () => {
    await withMembers()

    const rows = screen.getAllByRole('button', { name: 'Remove' })
    await press(rows[2])

    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Anonymous Marmot was removed.',
    ])
    // The row goes at once; the request waits for Undo to have its chance.
    expect(screen.queryByText('Anonymous Marmot')).toBeNull()
  })
})
