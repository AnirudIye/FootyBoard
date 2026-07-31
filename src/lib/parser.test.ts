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

describe('parseCommand — a depth named with a shape', () => {
  /**
   * The bug: only the noun phrases were recognised, so the bare adjective on the
   * end of a shape was dropped and the team was set up at the base height with
   * nothing said about it. Every case here names a formation *and* a depth, and
   * both have to survive into the command.
   */
  const cases: [string, string, string][] = [
    ['set up a 4-3-3 high', '4-3-3', 'high'],
    ['put them in a 4-4-2 mid', '4-4-2', 'mid'],
    ['set up a 4-2-3-1 low', '4-2-3-1', 'default'],
    ['4-3-3 higher up the pitch', '4-3-3', 'high'],
    ['line them up in a 5-4-1 deep', '5-4-1', 'default'],
    ['3-5-2 low block', '3-5-2', 'default'],
    ['4-1-4-1 mid block', '4-1-4-1', 'mid'],
    ['set up a 4-3-3 high press', '4-3-3', 'high'],
    ['put us in a 3-4-3 with a high line', '3-4-3', 'high'],
    ['4-4-1-1 sitting deep', '4-4-1-1', 'default'],
  ]
  for (const [input, name, block] of cases) {
    it(`reads "${input}" as a ${name} at ${block}`, () => {
      expect(parseCommand(input, ctx).command).toMatchObject({ type: 'setFormation', name, block })
    })
  }

  it('still defaults to the base height when no depth is named', () => {
    expect(parseCommand('set up a 4-3-3', ctx).command).toMatchObject({ block: 'default' })
  })

  it('says the depth back, so a dropped one is visible in the reply', () => {
    expect(parseCommand('set up a 4-3-3 high', ctx).reply).toMatch(/high line/)
    expect(parseCommand('put them in a 4-4-2 mid', ctx).reply).toMatch(/mid block/)
  })
})

describe('parseCommand — block height alone', () => {
  const bare: [string, string][] = [
    ['push them high', 'high'],
    ['go higher', 'high'],
    ['push up', 'high'],
    ['move them up the pitch', 'high'],
    ['sit mid', 'mid'],
    ['drop them deeper', 'default'],
    ['go low', 'default'],
    ['sit deep', 'default'],
  ]
  for (const [input, block] of bare) {
    it(`reads "${input}" as ${block}`, () => {
      expect(parseCommand(input, ctx).command).toMatchObject({ type: 'setBlock', block })
    })
  }

  it('reads the comparatives, which the old guard rejected', () => {
    // `\bhigh\b` does not match "higher" and `\bdeep\b` does not match "deeper",
    // so the second regex that used to sit on this rule threw both away right
    // after detectBlock had recognised them.
    expect(parseCommand('push the away team higher', ctx).command).toEqual({
      type: 'setBlock',
      side: 'away',
      block: 'high',
    })
    expect(parseCommand('drop the away team deeper', ctx).command).toEqual({
      type: 'setBlock',
      side: 'away',
      block: 'default',
    })
  })

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

describe('parseCommand — a question is not an instruction', () => {
  /**
   * The bug this guard exists for: every one of these names a formation, and
   * every rule in the parser needed nothing more than that. So the board used
   * to answer "how do I play against a 4-3-3" by becoming a 4-3-3, moving
   * eleven players the coach had placed, and calling that a reply.
   */
  const questions = [
    'how do i play against a 4-3-3',
    'how do we beat a 4-2-3-1',
    'how should we set up against a 3-5-2',
    "what's the best way to break down a 5-4-1",
    'how do you counter a 4-4-2',
    'what beats a 4-4-2',
    'weaknesses of a 4-3-3',
    'what are the strengths of a 3-4-3',
    'why does a 4-3-3 struggle against a 3-5-2',
    'should i play 4-3-3 or 4-2-3-1',
    'tips for playing a 4-1-4-1',
    'advice on the 3-5-2',
    'explain the 4-2-3-1',
    'how do i stop their 9',
  ]
  for (const q of questions) {
    it(`leaves the board alone for "${q}"`, () => {
      const r = parseCommand(q, ctx)
      expect(r.command).toBeNull()
      expect(r.asking).toBe(true)
    })
  }

  it('says where a tactical answer has to come from, and what is left offline', () => {
    const r = parseCommand('how do i play against a 4-3-3', ctx)
    expect(r.reply).toMatch(/online assistant/)
    // The shape it recognised, so asking for it is one more word rather than a
    // rephrasing of the whole message.
    expect(r.reply).toContain('4-3-3')
  })

  it('does not name a shape it did not find', () => {
    expect(parseCommand('how do we press higher', ctx).reply).not.toMatch(/\d-\d/)
  })

  /**
   * The other half of the guard, and the half that would break the product if
   * it got this wrong: an instruction that happens to contain a word a question
   * also uses must still reach the board.
   */
  const instructions: [string, string][] = [
    ['set up a 4-3-3', 'setFormation'],
    ['set the away team up in a 4-4-2 mid block', 'setFormation'],
    ['put them in a 4-2-3-1 high line', 'setFormation'],
    ['4-3-3 high press', 'setFormation'],
    ['4231 for the opponent', 'setFormation'],
    ['play the animation', 'play'],
    ['what do you see', 'readBoard'],
    ['read the board', 'readBoard'],
    ['show the attacking half', 'setView'],
    ['switch to a mid block', 'setBlock'],
    ['push the away team onto a high line', 'setBlock'],
    ['move 9 to the left wing', 'movePlayer'],
    ['drop 6 deeper', 'movePlayer'],
    ['clear the arrows', 'clearDrawings'],
    ['reset the board', 'resetBoard'],
    ['bring 12 back on', 'returnPlayer'],
  ]
  for (const [input, type] of instructions) {
    it(`still runs "${input}"`, () => {
      const r = parseCommand(input, ctx)
      expect(r.command?.type).toBe(type)
      expect(r.asking).toBeFalsy()
    })
  }

  it('sends a phrasing that is both to the half that can do both', () => {
    // "how do I set up a 4-3-3" is a question wearing an instruction, and it
    // goes to the AI on purpose: the model can call setFormation and does, so
    // nothing is lost there. Offline the reply names the shape it saw, which is
    // the whole reason NEEDS_AI carries one.
    const r = parseCommand('how do i set up a 4-3-3', ctx)
    expect(r.command).toBeNull()
    expect(r.reply).toContain('4-3-3')
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
