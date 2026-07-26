import { describe, it, expect } from 'vitest'
import { applyOp } from './apply'
import type { BoardSlice } from './apply'
import type { Token, Drawing } from '../types'

/**
 * What a peer's op means, tested without a store, a socket or a React tree.
 * This is the part that has to be exactly right — everything else is plumbing
 * around it.
 */

const token = (id: string, over: Partial<Token> = {}): Token => ({
  id,
  type: 'player',
  teamId: 'home',
  number: 9,
  color: '#B4432E',
  shape: 'outfield',
  x: 50,
  y: 50,
  rotation: 0,
  ...over,
})

const drawing = (id: string, over: Partial<Drawing> = {}): Drawing => ({
  id,
  type: 'arrow',
  points: [10, 10, 20, 20],
  color: '#2ae07a',
  thickness: 2.4,
  ...over,
})

const board = (over: Partial<BoardSlice> = {}): BoardSlice => ({
  teams: [
    { id: 'home', side: 'home', name: 'Home', color: '#B4432E' },
    { id: 'away', side: 'away', name: 'Away', color: '#2C5B8A' },
  ],
  tokens: [token('a'), token('b', { x: 20, y: 20 })],
  bench: [token('sub', { number: 12 })],
  drawings: [drawing('d1')],
  frames: [],
  view: {
    view: 'fullH',
    kind: '11',
    grass: true,
    lineColor: '#F2F6F1',
    overlayGrid: false,
    pitchTheme: 'dark',
    snap: false,
  },
  customFormations: [],
  ...over,
})

describe('patch', () => {
  it('moves a token', () => {
    const next = applyOp(board(), { type: 'patch', entity: 'token', id: 'a', patch: { x: 70, y: 30 } })
    expect(next.tokens?.find((t) => t.id === 'a')).toMatchObject({ x: 70, y: 30 })
  })

  it('carries an attached annotation along with the player', () => {
    const state = board({ drawings: [drawing('d1', { attachedTokenId: 'a' })] })
    const next = applyOp(state, { type: 'patch', entity: 'token', id: 'a', patch: { x: 60, y: 50 } })
    // The chip moved +10 in x, so its pinned arrow moves with it.
    expect(next.drawings?.[0].points).toEqual([20, 10, 30, 20])
  })

  it('leaves unattached annotations alone', () => {
    const next = applyOp(board(), { type: 'patch', entity: 'token', id: 'a', patch: { x: 60, y: 50 } })
    expect(next.drawings?.[0].points).toEqual([10, 10, 20, 20])
  })

  it('drops an op for a token that no longer exists', () => {
    // Someone deleted it while someone else was dragging it. The delete was the
    // later decision, so the move is discarded rather than resurrecting a chip.
    expect(applyOp(board(), { type: 'patch', entity: 'token', id: 'gone', patch: { x: 1, y: 1 } })).toEqual({})
  })

  it('drops an op for a drawing that no longer exists', () => {
    expect(applyOp(board(), { type: 'patch', entity: 'drawing', id: 'gone', patch: { color: '#fff' } })).toEqual({})
  })

  it('patches a team', () => {
    const next = applyOp(board(), { type: 'patch', entity: 'team', id: 'home', patch: { name: 'City' } })
    expect(next.teams?.find((t) => t.id === 'home')?.name).toBe('City')
  })
})

describe('add', () => {
  it('adds a token', () => {
    const next = applyOp(board(), { type: 'add', entity: 'token', item: token('c') })
    expect(next.tokens).toHaveLength(3)
  })

  it('ignores an add for an id already present', () => {
    // A reconnect can replay an op that already landed, and a duplicated chip
    // is both visible and awkward to get rid of.
    expect(applyOp(board(), { type: 'add', entity: 'token', item: token('a') })).toEqual({})
    expect(applyOp(board(), { type: 'add', entity: 'drawing', item: drawing('d1') })).toEqual({})
  })
})

describe('remove', () => {
  it('removes a drawing', () => {
    const next = applyOp(board(), { type: 'remove', entity: 'drawing', ids: ['d1'] })
    expect(next.drawings).toHaveLength(0)
  })

  it('removes a mixed selection of chips and annotations at once', () => {
    const next = applyOp(board(), { type: 'remove', entity: 'selection', ids: ['a', 'd1'] })
    expect(next.tokens?.map((t) => t.id)).toEqual(['b'])
    expect(next.drawings).toHaveLength(0)
  })

  it('detaches an annotation pinned to a chip that is going away', () => {
    const state = board({ drawings: [drawing('d1', { attachedTokenId: 'a' })] })
    const next = applyOp(state, { type: 'remove', entity: 'selection', ids: ['a'] })
    expect(next.drawings?.[0].attachedTokenId).toBeUndefined()
  })
})

describe('bulk', () => {
  it('repositions and renumbers a whole team', () => {
    const next = applyOp(board(), {
      type: 'bulk',
      tokens: [
        { id: 'a', x: 10, y: 10, number: 1, shape: 'keeper' },
        { id: 'b', x: 30, y: 40, number: 4, shape: 'outfield' },
      ],
    })
    expect(next.tokens?.find((t) => t.id === 'a')).toMatchObject({ x: 10, y: 10, number: 1, shape: 'keeper' })
    expect(next.tokens?.find((t) => t.id === 'b')).toMatchObject({ x: 30, y: 40, number: 4 })
  })

  it('moves each token’s attachments by that token’s own delta', () => {
    const state = board({
      drawings: [drawing('d1', { attachedTokenId: 'a' }), drawing('d2', { attachedTokenId: 'b' })],
    })
    const next = applyOp(state, {
      type: 'bulk',
      tokens: [
        { id: 'a', x: 55, y: 50 }, // +5
        { id: 'b', x: 20, y: 30 }, // +0, +10
      ],
    })
    expect(next.drawings?.[0].points).toEqual([15, 10, 25, 20])
    expect(next.drawings?.[1].points).toEqual([10, 20, 20, 30])
  })

  it('ignores ids it does not recognise', () => {
    const next = applyOp(board(), { type: 'bulk', tokens: [{ id: 'gone', x: 1, y: 1 }] })
    expect(next.tokens).toEqual(board().tokens)
  })
})

describe('bench', () => {
  it('moves a player to the bench', () => {
    const next = applyOp(board(), { type: 'bench', id: 'a' })
    expect(next.tokens?.map((t) => t.id)).toEqual(['b'])
    expect(next.bench?.map((t) => t.id)).toEqual(['sub', 'a'])
  })

  it('brings a substitute on at the position the sender chose', () => {
    const next = applyOp(board(), { type: 'unbench', id: 'sub', x: 33, y: 66 })
    expect(next.bench).toHaveLength(0)
    expect(next.tokens?.at(-1)).toMatchObject({ id: 'sub', x: 33, y: 66 })
  })

  it('drops a bench op for someone already off the pitch', () => {
    expect(applyOp(board(), { type: 'bench', id: 'sub' })).toEqual({})
    expect(applyOp(board(), { type: 'unbench', id: 'a', x: 1, y: 1 })).toEqual({})
  })
})

describe('view', () => {
  it('merges into the existing settings rather than replacing them', () => {
    const next = applyOp(board(), { type: 'view', patch: { view: 'attackHalf' } })
    expect(next.view).toMatchObject({ view: 'attackHalf', kind: '11', grass: true })
  })
})

describe('immutability', () => {
  it('never mutates the state it was given', () => {
    const state = board({ drawings: [drawing('d1', { attachedTokenId: 'a' })] })
    const snapshot = structuredClone(state)
    applyOp(state, { type: 'patch', entity: 'token', id: 'a', patch: { x: 99, y: 99 } })
    applyOp(state, { type: 'remove', entity: 'selection', ids: ['a'] })
    applyOp(state, { type: 'bulk', tokens: [{ id: 'b', x: 1, y: 1 }] })
    expect(state).toEqual(snapshot)
  })
})
