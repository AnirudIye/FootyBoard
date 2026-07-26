import { describe, it, expect } from 'vitest'
import {
  getFormation,
  applyBlock,
  mirror,
  FORMATION_NAMES,
  formationCode,
} from './formations'

describe('formations', () => {
  it('lists the 10 core 11-a-side presets', () => {
    for (const n of [
      '4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '3-5-2',
      '3-4-3', '5-3-2', '5-4-1', '4-4-1-1', '4-3-2-1',
    ])
      expect(FORMATION_NAMES['11']).toContain(n)
  })
  it('returns 11 positions with the keeper most defensive', () => {
    const p = getFormation('4-3-3', '11')
    expect(p).toHaveLength(11)
    const minX = Math.min(...p.map((q) => q.x))
    expect(p[0].x).toBe(minX) // index 0 is GK
  })
  it('returns 7 positions for a 7-a-side set', () => {
    expect(getFormation(FORMATION_NAMES['7aside'][0], '7aside')).toHaveLength(7)
  })
  it('returns 5 positions for a futsal set', () => {
    expect(getFormation(FORMATION_NAMES['futsal'][0], 'futsal')).toHaveLength(5)
  })
  it('throws on an unknown formation', () => {
    expect(() => getFormation('9-1-0', '11')).toThrow()
  })
  it('high block pushes the outfield further up than default', () => {
    const base = getFormation('4-4-2', '11')
    const high = applyBlock(base, 'high')
    const outfieldBase = base.slice(1).reduce((s, q) => s + q.x, 0)
    const outfieldHigh = high.slice(1).reduce((s, q) => s + q.x, 0)
    expect(outfieldHigh).toBeGreaterThan(outfieldBase)
  })
  it('mirror reflects through pitch center', () => {
    expect(mirror([{ x: 20, y: 30 }])[0]).toEqual({ x: 80, y: 70 })
  })
  it('normalizes formation codes', () => {
    expect(formationCode('433')).toBe('4-3-3')
    expect(formationCode('4-3-3')).toBe('4-3-3')
  })

  it('numbers every slot uniquely within a formation, keeper as 1', () => {
    for (const kind of ['11', '7aside', 'futsal'] as const) {
      for (const name of FORMATION_NAMES[kind]) {
        const slots = getFormation(name, kind)
        expect(slots[0].n).toBe(1) // keeper
        const numbers = slots.map((s) => s.n)
        expect(new Set(numbers).size).toBe(numbers.length) // no duplicates
      }
    }
  })

  it('assigns numbers to positions by footballing convention', () => {
    // In a 4-3-3: 6 is the single pivot, 10 the deepest-mid playmaker, 9 up top.
    const f = getFormation('4-3-3', '11')
    const six = f.find((s) => s.n === 6)!
    const nine = f.find((s) => s.n === 9)!
    const two = f.find((s) => s.n === 2)!
    // The 9 is the most advanced player; the 2 (full-back) sits deep.
    expect(nine.x).toBeGreaterThan(six.x)
    expect(two.x).toBeLessThan(six.x)
    // The pitch is widthwise centred on the pivot and striker (y ≈ 50).
    expect(Math.abs(six.y - 50)).toBeLessThan(6)
    expect(Math.abs(nine.y - 50)).toBeLessThan(6)
  })
})
