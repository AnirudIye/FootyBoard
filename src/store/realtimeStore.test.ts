import { describe, it, expect, beforeEach } from 'vitest'
import { useRealtimeStore, peerColor, peerInitial } from './realtimeStore'

/**
 * Two questions that are not the same question:
 *
 *   - "Is editing locked on this board?"  — a property of the board.
 *   - "Am I prevented from editing?"      — a property of the board *and* me.
 *
 * The owner is never locked out by their own lock, so for them the answers
 * differ. Collapsing the two into one field is what broke the share dialog: the
 * owner had nowhere to read the board's real state from, so it read a stale
 * copy out of the board list instead and showed the opposite of the truth.
 */

beforeEach(() => useRealtimeStore.getState().reset())

const welcomeAs = (role: 'owner' | 'member', locked: boolean) =>
  useRealtimeStore.getState().welcome('me', role, locked, [])

describe('the board lock, as the owner sees it', () => {
  it('reports the board as locked while leaving the owner able to edit', () => {
    welcomeAs('owner', true)
    const s = useRealtimeStore.getState()
    expect(s.boardLocked).toBe(true)
    expect(s.locked).toBe(false)
  })

  it('tracks a lock the owner sets from another tab', () => {
    welcomeAs('owner', false)
    useRealtimeStore.getState().setLocked(true)

    const s = useRealtimeStore.getState()
    expect(s.boardLocked).toBe(true)
    expect(s.locked).toBe(false)
  })

  it('unlocks again', () => {
    welcomeAs('owner', true)
    useRealtimeStore.getState().setLocked(false)
    expect(useRealtimeStore.getState().boardLocked).toBe(false)
  })
})

describe('the board lock, as a member sees it', () => {
  it('locks them out when the board is locked', () => {
    welcomeAs('member', true)
    const s = useRealtimeStore.getState()
    expect(s.boardLocked).toBe(true)
    expect(s.locked).toBe(true)
  })

  it('lets them edit when it is not', () => {
    welcomeAs('member', false)
    expect(useRealtimeStore.getState().locked).toBe(false)
  })

  it('follows a lock broadcast', () => {
    welcomeAs('member', false)
    useRealtimeStore.getState().setLocked(true)
    expect(useRealtimeStore.getState().locked).toBe(true)

    useRealtimeStore.getState().setLocked(false)
    expect(useRealtimeStore.getState().locked).toBe(false)
  })
})

describe('presence', () => {
  it('leaves the client itself out of its own peer list', () => {
    useRealtimeStore.getState().welcome('me', 'owner', false, [
      { id: 'me', email: 'me@example.com' },
      { id: 'them', email: 'them@example.com' },
    ])
    expect(Object.keys(useRealtimeStore.getState().peers)).toEqual(['them'])
  })

  it('takes a peer’s cursor and selection with them when they leave', () => {
    welcomeAs('owner', false)
    useRealtimeStore.getState().peerJoined('them', 'them@example.com')
    useRealtimeStore.getState().setCursor('them', 10, 20)
    expect(useRealtimeStore.getState().peers.them.cursor).toEqual({ x: 10, y: 20 })

    useRealtimeStore.getState().peerLeft('them')
    expect(useRealtimeStore.getState().peers.them).toBeUndefined()
  })

  it('ignores cursor and selection for someone not in the room', () => {
    welcomeAs('owner', false)
    useRealtimeStore.getState().setCursor('ghost', 1, 1)
    useRealtimeStore.getState().setPeerSelection('ghost', ['a'])
    expect(useRealtimeStore.getState().peers).toEqual({})
  })

  it('re-announcing a peer does not duplicate them', () => {
    welcomeAs('owner', false)
    useRealtimeStore.getState().peerJoined('them', 'them@example.com')
    useRealtimeStore.getState().peerJoined('them', 'them@example.com')
    expect(Object.keys(useRealtimeStore.getState().peers)).toHaveLength(1)
  })

  it('labels a peer by the part of their address in front of the @', () => {
    // What the relay discloses on a board that names people normally is the
    // whole address, and a cursor label is not the place for a domain.
    welcomeAs('owner', false)
    useRealtimeStore
      .getState()
      .peerJoined('them', 'anirud@gmail.com', 'anirud@gmail.com')

    const peer = useRealtimeStore.getState().peers.them
    expect(peer.displayName).toBe('anirud')
    expect(peer.email).toBe('anirud@gmail.com')
  })

  it('leaves a generated name exactly as the relay sent it', () => {
    welcomeAs('owner', false)
    useRealtimeStore.getState().peerJoined('them', 'Anonymous Badger', 'Anonymous Badger')
    expect(useRealtimeStore.getState().peers.them.displayName).toBe('Anonymous Badger')
  })

  it('takes an avatar initial from the animal, not from "Anonymous"', () => {
    // The one mode this feature exists for is the one where every name starts
    // with the same letter, so the first letter is the one that cannot be used.
    expect(peerInitial({ displayName: 'Anonymous Badger' })).toBe('B')
    expect(peerInitial({ displayName: 'Anonymous Quokka' })).toBe('Q')
    expect(peerInitial({ displayName: 'anirud' })).toBe('A')
    expect(peerInitial({ displayName: '' })).toBe('?')
  })

  it('gives a peer the same colour on every client', () => {
    // Derived from the id rather than assigned, so two clients agree without
    // having to coordinate.
    expect(peerColor('abc-123')).toBe(peerColor('abc-123'))
    expect(peerColor('abc-123')).not.toBe(peerColor('xyz-789'))
  })
})

describe('reset', () => {
  it('clears the lock along with everything else', () => {
    welcomeAs('member', true)
    useRealtimeStore.getState().reset()
    const s = useRealtimeStore.getState()
    expect(s.locked).toBe(false)
    expect(s.boardLocked).toBe(false)
    expect(s.role).toBeNull()
  })
})
