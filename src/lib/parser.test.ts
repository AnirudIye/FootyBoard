import { describe, it, expect } from 'vitest'
import { parseCommand } from './parser'
import type { ParseContext } from './parser'
import { FORMATION_NAMES } from './formations'

const ctx: ParseContext = { formationNames: FORMATION_NAMES['11'], kind: '11' }

describe('parseCommand — formations', () => {
  it('sets a formation with an explicit team and block', () => {
    const r = parseCommand('set the away team up in a 4-4-2 mid block', ctx)
    expect(r.command).toEqual({ type: 'setFormation', side: 'away', name: '4-4-2', block: 'mid' })
  })

  it('defaults to the home team', () => {
    const r = parseCommand('set up a 4-3-3', ctx)
    expect(r.command).toEqual({ type: 'setFormation', side: 'home', name: '4-3-3', block: 'default' })
  })

  it('reads dashless formation codes', () => {
    expect(parseCommand('4231 for the opponent', ctx).command).toEqual({
      type: 'setFormation',
      side: 'away',
      name: '4-2-3-1',
      block: 'default',
    })
  })

  it('resolves team synonyms', () => {
    expect(parseCommand('put them in a 5-3-2', ctx).command).toMatchObject({ side: 'away' })
    expect(parseCommand('set us up in a 3-4-3', ctx).command).toMatchObject({ side: 'home' })
  })

  it('picks up a high line', () => {
    expect(parseCommand('4-3-3 high press', ctx).command).toMatchObject({ block: 'high' })
  })

  it('rejects a formation that does not exist', () => {
    expect(parseCommand('set up a 9-1-0', ctx).command).toBeNull()
  })
})

describe('parseCommand — block height alone', () => {
  it('switches to a mid block without a formation', () => {
    expect(parseCommand('switch to a mid block', ctx).command).toEqual({
      type: 'setBlock',
      side: 'home',
      block: 'mid',
    })
  })
  it('drops the away team into a deep block', () => {
    expect(parseCommand('make the away team sit deep', ctx).command).toEqual({
      type: 'setBlock',
      side: 'away',
      block: 'default',
    })
  })
})

describe('parseCommand — board commands', () => {
  const cases: [string, string][] = [
    ['clear the arrows', 'clearDrawings'],
    ['remove all annotations', 'clearDrawings'],
    ['reset the board', 'resetBoard'],
    ['start over', 'resetBoard'],
    ['flip the pitch', 'setView'],
    ['make it vertical', 'setView'],
    ['show the attacking half', 'setView'],
    ['toggle the channels', 'toggleGrid'],
    ['show the halfspaces', 'toggleGrid'],
    ['add a frame', 'addFrame'],
    ['take a snapshot', 'addFrame'],
    ['play the animation', 'play'],
    ['fit the pitch', 'fit'],
    ['read the board', 'readBoard'],
    ['what do you see', 'readBoard'],
  ]
  for (const [input, type] of cases) {
    it(`maps "${input}" to ${type}`, () => {
      expect(parseCommand(input, ctx).command?.type).toBe(type)
    })
  }

  it('flip to vertical does not also match horizontal', () => {
    expect(parseCommand('flip the pitch', ctx).command).toMatchObject({ view: 'fullV' })
  })
})

describe('parseCommand — declines the unknown', () => {
  it('returns no command with a capability reply for off-topic input', () => {
    const r = parseCommand('what is the meaning of life', ctx)
    expect(r.command).toBeNull()
    expect(r.reply).toContain('set a formation')
  })
  it('declines an empty message', () => {
    expect(parseCommand('   ', ctx).command).toBeNull()
  })
})
