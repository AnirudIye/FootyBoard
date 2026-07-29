import { describe, it, expect } from 'vitest'
import { isPersistedBoard, SCHEMA_VERSION } from './persistence'
import type { PersistedBoard } from './persistence'
import type { ViewSettings } from './types'
import { useBoardStore, defaultPersistedBoard } from '../store/boardStore'

const view: ViewSettings = {
  view: 'fullH',
  kind: '11',
  grass: true,
  lineColor: '#5ff2d0',
  overlayGrid: false,
  pitchTheme: 'dark',
  snap: false,
}

const sample: PersistedBoard = {
  version: SCHEMA_VERSION,
  teams: [],
  tokens: [],
  bench: [],
  drawings: [],
  frames: [],
  view,
  customFormations: [],
}

describe('persistence', () => {
  it('rejects a board that has the right version but the wrong shape', () => {
    // What a truncated or hand-edited server payload looks like.
    expect(isPersistedBoard({ version: SCHEMA_VERSION, hello: 'world' })).toBe(false)
    expect(isPersistedBoard({ ...sample, tokens: undefined })).toBe(false)
    expect(isPersistedBoard({ ...sample, frames: 'nope' })).toBe(false)
    expect(isPersistedBoard({ ...sample, view: null })).toBe(false)
    expect(isPersistedBoard(null)).toBe(false)
    expect(isPersistedBoard('a string')).toBe(false)
    expect(isPersistedBoard(sample)).toBe(true)
  })

  it('rejects an older schema version', () => {
    expect(isPersistedBoard({ ...sample, version: 0 })).toBe(false)
  })

  it('still loads a board saved before the bench existed', () => {
    const { bench: _bench, ...withoutBench } = sample
    expect(isPersistedBoard(withoutBench)).toBe(true)
  })
})

/**
 * The guard and the serialiser, held against each other.
 *
 * This stopped being a client-only question. `POST /api/boards` used to accept
 * any payload at all, which is how the dev database collected rows the client
 * then refused to open, so the API now runs this same guard on write: the one
 * in `boardSchema.js`, imported by both ends rather than copied into the second
 * one.
 *
 * That makes the failure mode worth naming, because it points the other way
 * from the bug it fixes. A guard that drifted *stricter* than what the store
 * actually writes would not produce unreadable rows, it would refuse every save
 * the real app makes, for everybody, from the first keystroke. Sharing one
 * function makes the two ends unable to disagree with each other; only this
 * makes them unable to disagree with the board.
 */
describe('what the store writes is what both ends accept', () => {
  it('accepts a fresh board straight out of the store', () => {
    useBoardStore.getState().initDefaultBoard()
    expect(isPersistedBoard(useBoardStore.getState().getPersistable())).toBe(true)
  })

  it('accepts a board with work on it', () => {
    useBoardStore.getState().initDefaultBoard()
    const store = useBoardStore.getState()
    store.addFrame()
    store.moveToken(useBoardStore.getState().tokens[0]!.id, 42, 17)
    store.addDrawing({
      type: 'arrow',
      points: [10, 10, 20, 20],
      color: '#ffffff',
      thickness: 2,
    })

    expect(isPersistedBoard(useBoardStore.getState().getPersistable())).toBe(true)
  })

  it('accepts the payload a brand new account is created with', () => {
    // The one board written by `POST`, rather than by an autosave. It has its
    // own builder, so it is its own way for the two to fall out of step.
    expect(isPersistedBoard(defaultPersistedBoard())).toBe(true)
  })
})
