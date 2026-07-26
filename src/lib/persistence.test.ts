import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveBoard, loadBoard, isPersistedBoard, SCHEMA_VERSION } from './persistence'
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
  beforeEach(() => localStorage.clear())
  it('round-trips a board', () => {
    saveBoard(sample)
    expect(loadBoard()).toEqual(sample)
  })
  it('returns null when nothing is stored', () => {
    expect(loadBoard()).toBeNull()
  })
  it('returns null on corrupt json', () => {
    localStorage.setItem('soccerboard.board', '{not json')
    expect(loadBoard()).toBeNull()
  })
  it('returns null on an older schema version', () => {
    localStorage.setItem('soccerboard.board', JSON.stringify({ ...sample, version: 0 }))
    expect(loadBoard()).toBeNull()
  })

  it('explains why a stored board was discarded, in language a coach can read', () => {
    const said: string[] = []
    const collect = (m: string) => said.push(m)

    localStorage.setItem('soccerboard.board', '{not json')
    loadBoard(undefined, collect)
    localStorage.setItem('soccerboard.board', JSON.stringify({ ...sample, version: 0 }))
    loadBoard(undefined, collect)

    expect(said).toHaveLength(2)
    expect(said[0]).toContain('could not be read')
    expect(said[1]).toContain('older version')
  })

  it('stays quiet when there is nothing stored to complain about', () => {
    const onProblem = vi.fn()
    expect(loadBoard(undefined, onProblem)).toBeNull()
    saveBoard(sample)
    expect(loadBoard(undefined, onProblem)).toEqual(sample)
    expect(onProblem).not.toHaveBeenCalled()
  })

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

  it('still loads a board saved before the bench existed', () => {
    const { bench: _bench, ...withoutBench } = sample
    expect(isPersistedBoard(withoutBench)).toBe(true)
  })

  it('refuses a malformed stored board rather than returning it', () => {
    localStorage.setItem('soccerboard.board', JSON.stringify({ version: SCHEMA_VERSION, x: 1 }))
    const said: string[] = []
    expect(loadBoard(undefined, (m) => said.push(m))).toBeNull()
    expect(said).toHaveLength(1)
  })

  it('reports a failed write instead of dropping it silently', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(saveBoard(sample)).toBe(false)
    setItem.mockRestore()
    expect(saveBoard(sample)).toBe(true)
  })
})
