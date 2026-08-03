import { describe, it, expect } from 'vitest'
import { hitDrawings } from './erase'
import { createDrawing } from './drawings'
import type { Drawing, DrawingType } from './types'

const style = { color: '#2ae07a', thickness: 2.4, fillOpacity: 0.18, curve: 'right' as const }

/** A drawing with a known id, so a hit can be named rather than counted. */
const make = (
  id: string,
  type: DrawingType,
  points: number[],
  extra: { text?: string; control?: number[] } = {},
): Drawing => ({ ...createDrawing(type, points, style, extra), id })

/**
 * What the eraser disc is touching, in board units.
 *
 * This is the whole of the eraser's judgement, and it is here rather than behind
 * a gesture because a Konva stage cannot mount in jsdom — the same arrangement
 * `triangleFromDrag` is under. Every case below is a pointer placed deliberately
 * *near* a mark and deliberately *just past* it, because a hit test only has two
 * ways to be wrong and they are exactly those two.
 */
describe('hitDrawings: strokes', () => {
  it('takes a line the disc is sitting on, and leaves one it is not', () => {
    const line = make('l', 'line', [10, 50, 90, 50])
    expect(hitDrawings([line], 50, 51, 2)).toEqual(['l'])
    expect(hitDrawings([line], 50, 55, 2)).toEqual([])
  })

  /**
   * The distance is to the segment, not to the line it lies on. A pointer far
   * off the end of a stroke is near the infinite line through it and nowhere
   * near the ink, and a board is mostly short strokes on a big pitch.
   */
  it('does not take a stroke the disc is merely in line with', () => {
    const line = make('l', 'line', [10, 50, 30, 50])
    expect(hitDrawings([line], 80, 50, 2)).toEqual([])
  })

  it('follows a pen stroke round its corners rather than bounding it', () => {
    // An L: down the left edge, then along the bottom. The inside of the corner
    // is well within the bounding box and a long way from any ink.
    const pen = make('p', 'pen', [10, 10, 10, 60, 60, 60])
    expect(hitDrawings([pen], 11, 30, 2)).toEqual(['p'])
    expect(hitDrawings([pen], 40, 20, 2)).toEqual([])
  })

  it('takes an arrow and a dashed pass by their shaft', () => {
    const run = make('r', 'arrow', [20, 20, 60, 20])
    const pass = make('q', 'dashedArrow', [20, 80, 60, 80])
    expect(hitDrawings([run, pass], 40, 21, 2)).toEqual(['r'])
    expect(hitDrawings([run, pass], 40, 79, 2)).toEqual(['q'])
  })

  /**
   * A curve is erased where it is painted, which is not where its chord runs and
   * not where its control point sits either.
   *
   * A fresh curve is bent a quarter of its length aside, so the middle of the
   * chord is empty pitch: a hit test written against the two stored ends would
   * take a curve the coach swept nowhere near, and miss the ink they swept
   * straight through. The bow tops out halfway between the chord and the control
   * point, which is why this asks `quadraticPoints` rather than arithmetic.
   */
  it('follows the bow of a curve, not the chord under it', () => {
    const curve = make('c', 'curveArrow', [20, 50, 60, 50])
    expect(curve.control).toEqual([40, 60])
    expect(hitDrawings([curve], 40, 55, 1)).toEqual(['c'])
    expect(hitDrawings([curve], 40, 50, 3)).toEqual([])
  })

  it('erases a curve with no control point along its chord', () => {
    // Straight down the middle: with nothing stored, the curve collapses onto
    // the line between its ends, which is what `DrawingShape` draws.
    const flat = make('c', 'curvePass', [20, 50, 60, 50])
    delete flat.control
    expect(hitDrawings([flat], 40, 50, 1)).toEqual(['c'])
  })
})

describe('hitDrawings: zones', () => {
  it('takes a box from inside it or from just outside its edge', () => {
    const box = make('b', 'zoneRect', [20, 20, 60, 40])
    expect(hitDrawings([box], 40, 30, 2)).toEqual(['b'])
    expect(hitDrawings([box], 61, 30, 2)).toEqual(['b'])
    expect(hitDrawings([box], 65, 30, 2)).toEqual([])
    // Past a corner, diagonally: the nearest point of the box is the corner
    // itself. 1.5 out on each axis is inside a square of side 2 and outside a
    // disc of radius 2, which is the case a per-axis test gets wrong.
    expect(hitDrawings([box], 61, 41, 2)).toEqual(['b'])
    expect(hitDrawings([box], 61.5, 41.5, 2)).toEqual([])
  })

  it('reads a box the same whichever way it was dragged', () => {
    const forward = make('f', 'zoneRect', [20, 20, 60, 40])
    const backward = make('b', 'zoneRect', [60, 40, 20, 20])
    expect(hitDrawings([forward, backward], 40, 30, 2)).toEqual(['f', 'b'])
  })

  it('takes an oval from inside, and not from the corner of its box', () => {
    const oval = make('o', 'zoneEllipse', [20, 20, 60, 60])
    expect(hitDrawings([oval], 40, 40, 1)).toEqual(['o'])
    expect(hitDrawings([oval], 59, 40, 1)).toEqual(['o'])
    // Inside the bounding box, well outside the oval: the whole reason an
    // ellipse cannot be tested as a rectangle.
    expect(hitDrawings([oval], 22, 22, 1)).toEqual([])
  })

  it('treats an oval with no width as the line it looks like', () => {
    // A drag that never opened out. The radial test would divide by nought.
    const flat = make('o', 'zoneEllipse', [40, 20, 40, 60])
    expect(hitDrawings([flat], 40.5, 40, 1)).toEqual(['o'])
    expect(hitDrawings([flat], 45, 40, 1)).toEqual([])
  })

  it('takes a triangle from inside it, from its edge, and not from beyond', () => {
    // Apex at the top, base along the bottom.
    const tri = make('t', 'zoneTriangle', [50, 10, 20, 60, 80, 60])
    expect(hitDrawings([tri], 50, 40, 1)).toEqual(['t'])
    expect(hitDrawings([tri], 50, 61, 1)).toEqual(['t'])
    // Beside the apex: inside the bounding box, outside the shape.
    expect(hitDrawings([tri], 25, 15, 1)).toEqual([])
  })

  /**
   * The legacy four-number triangle, which stores the two ends of a drag rather
   * than its corners. `DrawingShape` still paints one through `triangleCorners`,
   * so the eraser has to test the same shape: otherwise the one triangle nobody
   * can redraw would also be the one nobody can rub out.
   */
  it('erases a legacy triangle as the shape it is painted as', () => {
    const legacy = make('t', 'zoneTriangle', [20, 10, 80, 60])
    expect(legacy.points).toHaveLength(4)
    // The apex is centred on the edge the drag started from, so the two top
    // corners of that box are empty pitch rather than part of the shape.
    expect(hitDrawings([legacy], 50, 40, 1)).toEqual(['t'])
    expect(hitDrawings([legacy], 22, 12, 1)).toEqual([])
  })

  it('takes a traced shape from inside and from its closing edge', () => {
    // A quadrilateral traced clockwise; the last edge back to the start is the
    // one a naive open-polyline test would forget.
    const poly = make('s', 'zonePoly', [20, 20, 60, 20, 60, 60, 20, 60])
    expect(hitDrawings([poly], 40, 40, 1)).toEqual(['s'])
    expect(hitDrawings([poly], 19.5, 40, 1)).toEqual(['s'])
    expect(hitDrawings([poly], 15, 40, 1)).toEqual([])
  })

  /**
   * The half-open edge comparison, which is the difference between this working
   * and failing for a pointer that happens to be level with a corner.
   *
   * A diamond has two vertices at the same height, so a ray cast from its centre
   * leaves through one of them. Counted with `>=` on both ends, that vertex is
   * crossed twice, the two cancel, and the very middle of the shape reports as
   * outside — a hole in the eraser that only appears at one exact latitude.
   */
  it('counts a vertex crossing once, so the middle of a diamond is inside it', () => {
    const diamond = make('d', 'zonePoly', [50, 10, 80, 40, 50, 70, 20, 40])
    expect(hitDrawings([diamond], 50, 40, 0)).toEqual(['d'])
  })
})

describe('hitDrawings: labels and the sweep as a whole', () => {
  it('takes a label by its anchor rather than by words it cannot measure', () => {
    const label = make('t', 'text', [40, 40], { text: 'PRESS HIGH' })
    expect(hitDrawings([label], 41, 41, 2)).toEqual(['t'])
    expect(hitDrawings([label], 44, 40, 2)).toEqual([])
  })

  it('names every mark under the disc at once, in board order', () => {
    const a = make('a', 'line', [10, 50, 90, 50])
    const b = make('b', 'zoneRect', [30, 30, 70, 70])
    const c = make('c', 'line', [10, 90, 90, 90])
    expect(hitDrawings([a, b, c], 50, 50, 2)).toEqual(['a', 'b'])
  })

  it('names nothing for an empty board, or for a disc over bare grass', () => {
    expect(hitDrawings([], 50, 50, 5)).toEqual([])
    expect(hitDrawings([make('l', 'line', [10, 10, 20, 10])], 90, 90, 5)).toEqual([])
  })

  /**
   * A radius of nought is what a caller gets if the pixel-to-board conversion
   * ever comes back empty, and it must mean "touching exactly", not "everything"
   * — a dead eraser is recoverable, one that clears the board is not.
   */
  it('erases only what it is exactly on when the radius is nought', () => {
    const line = make('l', 'line', [10, 50, 90, 50])
    expect(hitDrawings([line], 50, 50, 0)).toEqual(['l'])
    expect(hitDrawings([line], 50, 50.001, 0)).toEqual([])
  })
})
