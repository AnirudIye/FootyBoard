import { describe, it, expect, beforeEach } from 'vitest'
import { useBoardStore } from '../../store/boardStore'
import { dragChip } from './PlayerChip'

/** Four home players laid out along the goal line, left to right. */
function backFour(xs: number[]): string[] {
  const s = useBoardStore.getState()
  const squad = s.tokens.filter((t) => t.type === 'player' && t.teamId === 'home').slice(0, xs.length)
  squad.forEach((t, i) => useBoardStore.getState().updateToken(t.id, { x: xs[i], y: 50 }))
  return squad.map((t) => t.id)
}

const xsOf = (ids: string[]): number[] =>
  ids.map((id) => useBoardStore.getState().tokens.find((t) => t.id === id)!.x)

describe('dragChip', () => {
  beforeEach(() => useBoardStore.getState().initDefaultBoard())

  it('keeps the spacing when the dragged chip is the one that reaches the touchline', () => {
    // The chip under the pointer used to be filtered out of the group move and
    // clamped on its own, so it travelled the full delta while the rest of the
    // set stopped at the line: 8/18/28/38 landed on 0/0/10/20 with two chips
    // stacked. One delta for the whole set stops everybody together.
    const ids = backFour([8, 18, 28, 38])
    useBoardStore.getState().setSelection(ids)

    dragChip(ids[3], { x: 0, y: 50 }, { x: 38, y: 50 }, true)

    expect(xsOf(ids)).toEqual([0, 10, 20, 30])
  })

  it('keeps the spacing across the many small steps a real drag arrives in', () => {
    const ids = backFour([8, 18, 28, 38])
    useBoardStore.getState().setSelection(ids)

    // Sixty steps of one unit each, which carries the pointer well past the
    // line the set can reach.
    let from = { x: 38, y: 50 }
    for (let i = 1; i <= 60; i++) {
      const to = { x: 38 - i, y: 50 }
      dragChip(ids[3], to, from, true)
      from = to
    }

    expect(xsOf(ids)).toEqual([0, 10, 20, 30])
  })

  it('restores the shape when the set is dragged back off the line', () => {
    const ids = backFour([8, 18, 28, 38])
    useBoardStore.getState().setSelection(ids)

    dragChip(ids[3], { x: 0, y: 50 }, { x: 38, y: 50 }, true)
    dragChip(ids[3], { x: 30, y: 50 }, { x: 0, y: 50 }, true)

    expect(xsOf(ids)).toEqual([30, 40, 50, 60])
  })

  it('holds the shape against the far touchline as well', () => {
    const ids = backFour([62, 72, 82, 92])
    useBoardStore.getState().setSelection(ids)

    // Dragging the leftmost chip of the set rightwards is the mirror of the
    // same defect.
    dragChip(ids[0], { x: 100, y: 50 }, { x: 62, y: 50 }, true)

    expect(xsOf(ids)).toEqual([70, 80, 90, 100])
  })

  it('clamps vertically as a set too', () => {
    const s = useBoardStore.getState()
    const squad = s.tokens.filter((t) => t.type === 'player' && t.teamId === 'home').slice(0, 3)
    const ids = squad.map((t) => t.id)
    squad.forEach((t, i) => useBoardStore.getState().updateToken(t.id, { x: 50, y: 20 + i * 10 }))
    useBoardStore.getState().setSelection(ids)

    // Pulled past the goal line, so the set's own bounding box is what stops it.
    dragChip(ids[0], { x: 50, y: -10 }, { x: 50, y: 20 }, true)

    const ys = ids.map((id) => useBoardStore.getState().tokens.find((t) => t.id === id)!.y)
    expect(ys).toEqual([0, 10, 20])
  })

  it('moves one chip to the pointer when it is dragged on its own', () => {
    const ids = backFour([8, 18, 28, 38])
    useBoardStore.getState().setSelection([ids[3]])

    dragChip(ids[3], { x: 55, y: 40 }, { x: 38, y: 50 }, true)

    const moved = useBoardStore.getState().tokens.find((t) => t.id === ids[3])!
    expect(moved.x).toBeCloseTo(55, 6)
    expect(moved.y).toBeCloseTo(40, 6)
    // The rest of the board stayed where it was.
    expect(xsOf(ids.slice(0, 3))).toEqual([8, 18, 28])
  })

  it('leaves the selection alone when the dragged chip is not part of it', () => {
    const ids = backFour([8, 18, 28, 38])
    useBoardStore.getState().setSelection([ids[0], ids[1]])

    dragChip(ids[3], { x: 60, y: 50 }, { x: 38, y: 50 }, false)

    expect(xsOf(ids)).toEqual([8, 18, 28, 60])
  })
})
