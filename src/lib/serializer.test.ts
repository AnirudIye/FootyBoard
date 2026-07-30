import { describe, it, expect } from 'vitest'
import { describeTeam, describeBoard } from './serializer'
import { getFormation, applyBlock, mirror } from './formations'
import type { Token, ViewSettings } from './types'

// Build a home team's tokens from a formation preset.
function homeFrom(name: string, block: 'default' | 'mid' | 'high' = 'default'): Token[] {
  const pos = applyBlock(getFormation(name, '11'), block)
  return pos.map((p, i) => ({
    id: `h${i}`,
    type: 'player',
    teamId: 'home',
    color: '#000',
    shape: i === 0 ? 'keeper' : 'outfield',
    x: p.x,
    y: p.y,
    rotation: 0,
  }))
}

function awayFrom(name: string): Token[] {
  const pos = mirror(getFormation(name, '11'))
  return pos.map((p, i) => ({
    id: `a${i}`,
    type: 'player',
    teamId: 'away',
    color: '#000',
    shape: i === 0 ? 'keeper' : 'outfield',
    x: p.x,
    y: p.y,
    rotation: 0,
  }))
}

const view: ViewSettings = {
  view: 'fullH',
  kind: '11',
  grass: true,
  lineColor: '#fff',
  overlayGrid: false,
  pitchTheme: 'dark',
}

describe('describeTeam', () => {
  it('reads back the formation shape it was given', () => {
    expect(describeTeam(homeFrom('4-4-2'), 'home')).toContain('4-4-2')
    expect(describeTeam(homeFrom('4-3-3'), 'home')).toContain('4-3-3')
    expect(describeTeam(homeFrom('3-5-2'), 'home')).toContain('3-5-2')
  })

  it('names the back line by size and calls a level line flat', () => {
    const desc = describeTeam(homeFrom('4-4-2'), 'home')
    expect(desc).toContain('flat back four')
  })

  it('reports a lone striker for a single forward', () => {
    expect(describeTeam(homeFrom('4-2-3-1'), 'home')).toContain('lone striker')
  })

  it('reads block height from the defensive line', () => {
    expect(describeTeam(homeFrom('4-4-2', 'default'), 'home')).toContain('deep block')
    expect(describeTeam(homeFrom('4-4-2', 'high'), 'home')).toMatch(/mid block|high line/)
  })

  it('mirrors correctly for the away team', () => {
    expect(describeTeam(awayFrom('4-3-3'), 'away')).toContain('4-3-3')
  })
})

describe('describeBoard', () => {
  it('names the format and both teams', () => {
    const desc = describeBoard([...homeFrom('4-4-2'), ...awayFrom('4-3-3')], view)
    expect(desc).toContain('11-a-side')
    expect(desc).toContain('Home')
    expect(desc).toContain('Away')
  })

  it('names 7-a-side and futsal formats', () => {
    expect(describeBoard(homeFrom('4-4-2'), { ...view, kind: '7aside' })).toContain('7-a-side')
    expect(describeBoard(homeFrom('4-4-2'), { ...view, kind: 'futsal' })).toContain('futsal')
  })

  it('mentions training props when present', () => {
    const withProps: Token[] = [
      ...homeFrom('4-4-2'),
      { id: 'c1', type: 'cone', color: '#000', x: 30, y: 30, rotation: 0 },
    ]
    expect(describeBoard(withProps, view)).toContain('training props')
  })
})
