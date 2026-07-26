import { clampNorm } from './geometry'
import { AppError } from './errors'
import type { PitchKind } from './types'

export type BlockHeight = 'default' | 'mid' | 'high'

export interface Pos {
  x: number
  y: number
}

/** A formation position that also carries the shirt number for that role. */
export interface Slot extends Pos {
  n: number
}

const GK: Slot = { x: 6, y: 50, n: 1 }

// A line of players at a fixed distance up the pitch, each as [width, number].
const line = (x: number, players: [number, number][]): Slot[] =>
  players.map(([y, n]) => ({ x, y, n }))

// Home team attacks to the right. x grows toward the opponent goal; index 0 is
// always the goalkeeper (most defensive). y is the width axis, 0 top to 100
// bottom. Numbers follow footballing convention for each role: 1 keeper, 2/3
// full-backs, 4/5 centre-backs, 6 the holding midfielder, 8 central midfield,
// 10 the playmaker, 7/11 the wide players, 9 the striker.
const PRESETS: Record<string, Slot[]> = {
  '4-4-2': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(42, [[18, 7], [40, 6], [60, 8], [82, 11]]),
    ...line(62, [[40, 9], [60, 10]]),
  ],
  '4-3-3': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(42, [[28, 8], [50, 6], [72, 10]]),
    ...line(64, [[22, 7], [50, 9], [78, 11]]),
  ],
  '4-2-3-1': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(38, [[38, 6], [62, 8]]),
    ...line(52, [[22, 7], [50, 10], [78, 11]]),
    ...line(66, [[50, 9]]),
  ],
  '4-1-4-1': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(34, [[50, 6]]),
    ...line(46, [[18, 7], [40, 8], [60, 10], [82, 11]]),
    ...line(64, [[50, 9]]),
  ],
  '3-5-2': [
    GK,
    ...line(20, [[30, 4], [50, 5], [70, 3]]),
    ...line(40, [[14, 2], [34, 6], [50, 8], [66, 10], [86, 11]]),
    ...line(62, [[40, 9], [60, 7]]),
  ],
  '3-4-3': [
    GK,
    ...line(20, [[30, 4], [50, 5], [70, 3]]),
    ...line(42, [[18, 2], [40, 6], [60, 8], [82, 11]]),
    ...line(64, [[22, 7], [50, 9], [78, 10]]),
  ],
  '5-3-2': [
    GK,
    ...line(20, [[12, 2], [32, 4], [50, 5], [68, 3], [88, 11]]),
    ...line(42, [[30, 6], [50, 8], [70, 10]]),
    ...line(62, [[40, 9], [60, 7]]),
  ],
  '5-4-1': [
    GK,
    ...line(20, [[12, 2], [32, 4], [50, 5], [68, 3], [88, 6]]),
    ...line(42, [[18, 7], [40, 8], [60, 10], [82, 11]]),
    ...line(64, [[50, 9]]),
  ],
  '4-4-1-1': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(40, [[18, 7], [40, 6], [60, 8], [82, 11]]),
    ...line(54, [[50, 10]]),
    ...line(66, [[50, 9]]),
  ],
  '4-3-2-1': [
    GK,
    ...line(20, [[18, 2], [40, 4], [60, 5], [82, 3]]),
    ...line(40, [[28, 8], [50, 6], [72, 10]]),
    ...line(54, [[38, 7], [62, 11]]),
    ...line(66, [[50, 9]]),
  ],
  // 7-a-side
  '2-3-1': [
    GK,
    ...line(22, [[35, 2], [65, 3]]),
    ...line(46, [[25, 7], [50, 8], [75, 11]]),
    ...line(66, [[50, 9]]),
  ],
  // futsal
  '1-2-1': [
    GK,
    ...line(24, [[50, 5]]),
    ...line(48, [[32, 7], [68, 11]]),
    ...line(68, [[50, 9]]),
  ],
}

export const FORMATION_NAMES: Record<PitchKind, string[]> = {
  '11': ['4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '3-5-2', '3-4-3', '5-3-2', '5-4-1', '4-4-1-1', '4-3-2-1'],
  '7aside': ['2-3-1'],
  futsal: ['1-2-1'],
}

export const formationCode = (n: string): string =>
  n.includes('-') ? n : n.split('').join('-')

export function getFormation(name: string, _kind: PitchKind): Slot[] {
  const key = formationCode(name)
  const preset = PRESETS[key]
  if (!preset) throw new AppError(`There is no ${name} preset for this pitch size. Pick one from the formation list.`)
  return preset.map((q) => ({ ...q }))
}

const OFFSET: Record<BlockHeight, number> = { default: 0, mid: 8, high: 16 }

export function applyBlock<T extends Pos>(positions: T[], block: BlockHeight): T[] {
  const dx = OFFSET[block]
  return positions.map((q, i) => (i === 0 ? { ...q } : { ...q, ...clampNorm(q.x + dx, q.y) }))
}

export const mirror = <T extends Pos>(positions: T[]): T[] =>
  positions.map((q) => ({ ...q, x: 100 - q.x, y: 100 - q.y }))
