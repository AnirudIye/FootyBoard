import { describe, it, expect } from 'vitest'
import { isPersistedBoard, SCHEMA_VERSION } from './persistence'
import type { PersistedBoard } from './persistence'
import type { ViewSettings } from './types'

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
