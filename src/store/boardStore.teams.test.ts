import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from './boardStore'
import type { PitchKind, Side } from '../lib/types'

const home = () => useBoardStore.getState().tokens.filter((t) => t.teamId === 'home')
const away = () => useBoardStore.getState().tokens.filter((t) => t.teamId === 'away')

const SIDES: Side[] = ['home', 'away']
const onPitch = (side: Side) =>
  useBoardStore.getState().tokens.filter((t) => t.type === 'player' && t.teamId === side)
const onBench = (side: Side) => useBoardStore.getState().bench.filter((t) => t.teamId === side)

const SQUAD_SIZE: Record<PitchKind, number> = { '11': 11, '7aside': 7, futsal: 5 }

/**
 * What has to be true of a team after any format switch: a full side, no shirt
 * number worn twice anywhere in the squad, and exactly one keeper, numbered 1,
 * further from the opponent's goal than anyone else on the team.
 */
function expectCoherentSquad(side: Side, kind: PitchKind) {
  const pitch = onPitch(side)
  expect(pitch, `${side} squad size in ${kind}`).toHaveLength(SQUAD_SIZE[kind])

  // Pitch and bench together, because the collision was across the two: each
  // set was internally plausible and the union was not.
  const numbers = [...pitch, ...onBench(side)].map((t) => t.number)
  expect(numbers.includes(undefined), `${side} has an unnumbered player in ${kind}`).toBe(false)
  expect(new Set(numbers).size, `${side} shirt numbers in ${kind}: ${numbers.join(',')}`).toBe(
    numbers.length,
  )

  const keepers = pitch.filter((t) => t.shape === 'keeper')
  expect(keepers, `${side} keepers in ${kind}`).toHaveLength(1)
  expect(keepers[0].number).toBe(1)
  const outfield = pitch.filter((t) => t.shape !== 'keeper').map((t) => t.x)
  // Home attacks to the right, away to the left, so "in goal" is the far end.
  if (side === 'home') expect(keepers[0].x).toBeLessThan(Math.min(...outfield))
  else expect(keepers[0].x).toBeGreaterThan(Math.max(...outfield))
}

describe('active team', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('defaults to home and can be switched', () => {
    expect(useBoardStore.getState().activeTeam).toBe('home')
    useBoardStore.getState().setActiveTeam('away')
    expect(useBoardStore.getState().activeTeam).toBe('away')
  })
})

describe('positional numbering', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('numbers the default team by role (one keeper, a 6, a 9, a 10)', () => {
    const numbers = home()
      .map((t) => t.number)
      .sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const keeper = home().find((t) => t.shape === 'keeper')!
    expect(keeper.number).toBe(1)
  })

  it('applying a formation renumbers roles and keeps exactly one keeper', () => {
    // Reorder the roster so the keeper is no longer first in the array.
    const keeper = home().find((t) => t.shape === 'keeper')!
    useBoardStore.getState().benchToken(keeper.id)
    const sub = useBoardStore.getState().bench.find((t) => t.teamId === 'home')!
    useBoardStore.getState().unbenchToken(sub.id, 50, 50)

    useBoardStore.getState().applyFormation('home', '4-3-3', 'default')

    const keepers = home().filter((t) => t.shape === 'keeper')
    expect(keepers).toHaveLength(1)
    expect(keepers[0].number).toBe(1)
    const outfieldMinX = Math.min(...home().filter((t) => t.shape !== 'keeper').map((t) => t.x))
    expect(keepers[0].x).toBeLessThan(outfieldMinX)
  })
})

describe('setPitchKind', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('fields 7 a side each for a 7-a-side pitch and benches the rest', () => {
    const benchedBefore = useBoardStore.getState().bench.length
    useBoardStore.getState().setPitchKind('7aside')

    expect(home()).toHaveLength(7)
    expect(away()).toHaveLength(7)
    expect(useBoardStore.getState().bench.length).toBe(benchedBefore + 8)
    expect(useBoardStore.getState().view.kind).toBe('7aside')
  })

  it('fields 5 a side for futsal', () => {
    useBoardStore.getState().setPitchKind('futsal')
    expect(home()).toHaveLength(5)
    expect(away()).toHaveLength(5)
  })

  it('keeps exactly one keeper per team in every format', () => {
    for (const kind of ['7aside', 'futsal', '11'] as const) {
      useBoardStore.getState().setPitchKind(kind)
      expect(home().filter((t) => t.shape === 'keeper')).toHaveLength(1)
      expect(away().filter((t) => t.shape === 'keeper')).toHaveLength(1)
    }
  })

  it('refills the squads when going back up to 11 a side', () => {
    useBoardStore.getState().setPitchKind('futsal')
    useBoardStore.getState().setPitchKind('11')
    expect(home()).toHaveLength(11)
    expect(away()).toHaveLength(11)
    // Numbers stay unique within each team after the round trip.
    const nums = home().map((t) => t.number)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('is one undo step', () => {
    useBoardStore.getState().setPitchKind('futsal')
    useBoardStore.getState().undoAction()
    expect(useBoardStore.getState().view.kind).toBe('11')
    expect(home()).toHaveLength(11)
  })
})

/**
 * Resizing a squad used to renumber the players who stayed on into the new
 * format's positional set without noticing that the players being sent off
 * were carrying some of those same numbers to the bench. Both sets looked
 * right on their own and the total was unchanged, so every count-based check
 * passed while three numbers existed twice and three existed nowhere.
 */
describe('setPitchKind numbering', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  const TRANSITIONS: [PitchKind, PitchKind][] = [
    ['11', '7aside'],
    ['11', 'futsal'],
    ['7aside', 'futsal'],
    ['7aside', '11'],
    ['futsal', '11'],
    ['futsal', '7aside'],
  ]

  for (const [from, to] of TRANSITIONS) {
    it(`leaves a coherent squad going ${from} to ${to}`, () => {
      if (from !== '11') useBoardStore.getState().setPitchKind(from)
      for (const side of SIDES) expectCoherentSquad(side, from)

      useBoardStore.getState().setPitchKind(to)
      for (const side of SIDES) expectCoherentSquad(side, to)
    })
  }

  it('stays coherent through 11 to 7 to futsal and back to 11', () => {
    for (const kind of ['7aside', 'futsal', '11'] as PitchKind[]) {
      useBoardStore.getState().setPitchKind(kind)
      for (const side of SIDES) expectCoherentSquad(side, kind)
    }
  })

  it('keeps every player through a format switch rather than losing any', () => {
    const total = () => useBoardStore.getState().tokens.filter((t) => t.type === 'player').length +
      useBoardStore.getState().bench.length
    const before = total()
    for (const kind of ['7aside', 'futsal', '11'] as PitchKind[]) {
      useBoardStore.getState().setPitchKind(kind)
      expect(total()).toBe(before)
    }
  })

  it('brings a substitute on without putting two of the same number on the pitch', () => {
    useBoardStore.getState().setPitchKind('7aside')
    const sub = onBench('home')[0]
    useBoardStore.getState().unbenchToken(sub.id, 66, 50)

    const numbers = onPitch('home').map((t) => t.number)
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})

describe('switchPlayerTeam', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('flips a player to the other team, recolours, and avoids number clashes', () => {
    const player = home().find((t) => t.number === 6)!
    useBoardStore.getState().switchPlayerTeam(player.id)

    const moved = useBoardStore.getState().tokens.find((t) => t.id === player.id)!
    expect(moved.teamId).toBe('away')
    expect(moved.color).toBe(AWAY_COLOR)
    // The away team already had a 6, so the newcomer takes the next free number.
    const awayNumbers = away().map((t) => t.number)
    expect(new Set(awayNumbers).size).toBe(awayNumbers.length)
    expect(moved.number).toBe(12)
    expect(home()).toHaveLength(10)
    expect(away()).toHaveLength(12)
  })

  it('is a single undo step', () => {
    const player = home().find((t) => t.number === 9)!
    useBoardStore.getState().switchPlayerTeam(player.id)
    useBoardStore.getState().undoAction()
    const back = useBoardStore.getState().tokens.find((t) => t.id === player.id)!
    expect(back.teamId).toBe('home')
    expect(back.color).toBe(HOME_COLOR)
    expect(back.number).toBe(9)
  })
})
