import { describe, it, expect } from 'vitest'
import { parseCommand, zonePosition, ZONES } from './parser'
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

describe('parseCommand — one player at a time', () => {
  it('moves a numbered player to a named zone', () => {
    expect(parseCommand('move 9 to the left wing', ctx).command).toEqual({
      type: 'movePlayer',
      side: 'home',
      number: 9,
      zone: 'left-wing',
    })
  })

  it('takes the team from the same words the rest of the parser does', () => {
    expect(parseCommand('push their 10 into the right half-space', ctx).command).toEqual({
      type: 'movePlayer',
      side: 'away',
      number: 10,
      zone: 'right-halfspace',
    })
  })

  it('reads a zone that is also a block height as a zone once a number is named', () => {
    // "high line" and "deep" mean a block for a team and a place for a player.
    // The digit is what separates them, and the player rules run first.
    expect(parseCommand('push 5 onto the high line', ctx).command).toEqual({
      type: 'movePlayer',
      side: 'home',
      number: 5,
      zone: 'high-line',
    })
    expect(parseCommand('drop 6 deeper', ctx).command).toMatchObject({
      type: 'movePlayer',
      number: 6,
      zone: 'deep',
    })
  })

  it('still reads a formation with a block height as a formation', () => {
    // The shape check runs before the player rules for exactly this: without
    // that order the 4 of the shape gets sent up the pitch on its own.
    expect(parseCommand('put them in a 4-2-3-1 high line', ctx).command).toMatchObject({
      type: 'setFormation',
      name: '4-2-3-1',
    })
  })

  it('leaves a team-wide instruction as a block change', () => {
    expect(parseCommand('push the away team onto a high line', ctx).command).toEqual({
      type: 'setBlock',
      side: 'away',
      block: 'high',
    })
  })

  it('benches and returns a number', () => {
    expect(parseCommand('bench 4', ctx).command).toEqual({ type: 'benchPlayer', side: 'home', number: 4 })
    expect(parseCommand('take 7 off', ctx).command).toEqual({ type: 'benchPlayer', side: 'home', number: 7 })
    expect(parseCommand('bring 12 back on', ctx).command).toEqual({ type: 'returnPlayer', side: 'home', number: 12 })
    expect(parseCommand('bring on 14 for the away team', ctx).command).toEqual({
      type: 'returnPlayer',
      side: 'away',
      number: 14,
    })
  })

  it('does not read "sub 7 off" as bringing 7 on', () => {
    expect(parseCommand('sub 7 off', ctx).command).toEqual({ type: 'benchPlayer', side: 'home', number: 7 })
  })
})

describe('zonePosition', () => {
  it('gives every zone a point on the pitch', () => {
    for (const zone of ZONES) {
      const p = zonePosition(zone, 'home')
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(100)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(100)
    }
  })

  it('puts attacking zones in the half each team is attacking', () => {
    // Home attacks toward 100, away toward 0. A zone named for the final third
    // has to land in the right one or every AI instruction is inverted for one
    // of the two teams.
    expect(zonePosition('penalty-spot', 'home').x).toBeGreaterThan(80)
    expect(zonePosition('penalty-spot', 'away').x).toBeLessThan(20)
    expect(zonePosition('deep', 'home').x).toBeLessThan(30)
    expect(zonePosition('deep', 'away').x).toBeGreaterThan(70)
  })

  it("reads left and right from the moving team's own point of view", () => {
    // Away is a half-turn, not a flip, so their left wing is the far touchline
    // from home's.
    expect(zonePosition('left-wing', 'home').y).toBeLessThan(50)
    expect(zonePosition('left-wing', 'away').y).toBeGreaterThan(50)
  })

  it('leaves the centre circle where it is for both sides', () => {
    expect(zonePosition('center-circle', 'home')).toEqual({ x: 50, y: 50 })
    expect(zonePosition('center-circle', 'away')).toEqual({ x: 50, y: 50 })
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
