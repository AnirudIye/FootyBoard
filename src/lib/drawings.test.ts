import { describe, it, expect } from 'vitest'
import {
  createDrawing,
  isZone,
  isMark,
  isText,
  isDragType,
  isClickType,
  CLICK_CORNERS,
  shiftDrawing,
  shiftAttached,
} from './drawings'
import type { DrawStyle } from './drawings'
import { triangleCorners } from './geometry'
import type { Drawing } from './types'

const style: DrawStyle = { color: '#9c3b22', thickness: 2, fillOpacity: 0.2, curve: 'right' }

describe('drawing classification', () => {
  it('routes zones, marks and text to the right layers', () => {
    expect(isZone('zoneRect')).toBe(true)
    expect(isZone('zoneEllipse')).toBe(true)
    expect(isZone('zoneTriangle')).toBe(true)
    expect(isZone('zonePoly')).toBe(true)
    expect(isZone('arrow')).toBe(false)

    expect(isMark('arrow')).toBe(true)
    expect(isMark('pen')).toBe(true)
    expect(isMark('zoneRect')).toBe(false)
    expect(isMark('zoneTriangle')).toBe(false)
    expect(isMark('text')).toBe(false)

    expect(isText('text')).toBe(true)
  })

  /**
   * Not a restatement of the classification above. Being a zone decides which
   * band a shape is painted in; being a drag type is what makes the release
   * commit one at all. A shape that is neither a drag type nor a click type is
   * drawn to the screen during its gesture and then silently thrown away.
   *
   * The triangle is a **click** type: three presses, one corner each. It was a
   * drag type for a few hours, storing the two ends of a box and deriving its
   * apex, and this is the assertion that changed when that did.
   */
  it('places a triangle by clicking, and a box by dragging', () => {
    expect(isClickType('zoneTriangle')).toBe(true)
    expect(isDragType('zoneTriangle')).toBe(false)

    expect(isDragType('zoneRect')).toBe(true)
    expect(isClickType('zoneRect')).toBe(false)

    // The polygon is the other click type and differs only in when it ends.
    expect(isClickType('zonePoly')).toBe(true)
    expect(isDragType('zonePoly')).toBe(false)
  })

  /**
   * The number is what makes a triangle end without a keystroke, so it is worth
   * asserting rather than trusting: at three corners the gesture closes itself.
   * A polygon has no entry here, which is what "close on Enter instead" means.
   */
  it('closes a triangle at three corners and leaves a polygon open', () => {
    expect(CLICK_CORNERS.zoneTriangle).toBe(3)
    expect(CLICK_CORNERS.zonePoly).toBeUndefined()
  })
})

describe('createDrawing', () => {
  it('carries the active style onto every drawing', () => {
    const d = createDrawing('pen', [0, 0, 10, 10], style)
    expect(d.color).toBe('#9c3b22')
    expect(d.thickness).toBe(2)
  })

  it('gives zones a fill opacity and marks none', () => {
    expect(createDrawing('zoneRect', [0, 0, 10, 10], style).fillOpacity).toBe(0.2)
    expect(createDrawing('zoneTriangle', [0, 0, 10, 10], style).fillOpacity).toBe(0.2)
    expect(createDrawing('arrow', [0, 0, 10, 10], style).fillOpacity).toBeUndefined()
  })

  /**
   * A triangle stores the two corners of the drag and grows its third corner on
   * the way to the screen, so a stored triangle is the same four numbers a box
   * is. That is what lets everything which walks a point list — `shiftDrawing`,
   * `shiftAttached`, `bboxOf`, the selection outline — go on treating every
   * dragged zone alike, and it is the half that would rot first if a later hand
   * decided to bake the three corners in at creation instead.
   */
  it('stores a triangle as the drag it was made with, and derives the third corner', () => {
    const d = createDrawing('zoneTriangle', [10, 10, 40, 30], style)
    expect(d.points).toEqual([10, 10, 40, 30])
    expect(triangleCorners(d.points[0], d.points[1], d.points[2], d.points[3])).toHaveLength(6)
  })

  it('bends a curve to the side that was asked for', () => {
    const pts = [0, 0, 10, 0] // left to right along the x axis
    const left = createDrawing('curveArrow', pts, { ...style, curve: 'left' }).control!
    const right = createDrawing('curveArrow', pts, { ...style, curve: 'right' }).control!

    // Same midpoint, opposite sides of the line.
    expect(left[0]).toBeCloseTo(5, 6)
    expect(right[0]).toBeCloseTo(5, 6)
    expect(Math.sign(left[1])).toBe(-Math.sign(right[1]))
    expect(left[1]).not.toBe(0)
  })

  it('makes a curved pass dashed and a curved shot solid', () => {
    const pass = createDrawing('curvePass', [0, 0, 10, 10], style)
    const shot = createDrawing('curveArrow', [0, 0, 10, 10], style)
    expect(pass.dashed).toBe(true)
    expect(shot.dashed).toBeUndefined()
    expect(pass.control).toBeDefined()
    expect(shot.control).toBeDefined()
  })

  it('marks a pass arrow as dashed', () => {
    expect(createDrawing('dashedArrow', [0, 0, 10, 10], style).dashed).toBe(true)
    expect(createDrawing('arrow', [0, 0, 10, 10], style).dashed).toBeUndefined()
  })

  it('gives a curved arrow an off-axis control point by default', () => {
    const d = createDrawing('curveArrow', [0, 0, 100, 0], style)
    expect(d.control).toBeDefined()
    // A straight horizontal shaft should bow away from the line.
    expect(d.control![1]).not.toBeCloseTo(0, 3)
  })

  it('respects an explicit control point and text', () => {
    expect(createDrawing('curveArrow', [0, 0, 10, 0], style, { control: [5, 9] }).control).toEqual([5, 9])
    expect(createDrawing('text', [4, 4], style, { text: 'press here' }).text).toBe('press here')
  })

  it('copies the points rather than aliasing the caller array', () => {
    const pts = [1, 2, 3, 4]
    const d = createDrawing('pen', pts, style)
    pts[0] = 99
    expect(d.points[0]).toBe(1)
  })
})

describe('shiftDrawing', () => {
  it('translates points and the control point together', () => {
    const d: Drawing = {
      id: 'a',
      type: 'curveArrow',
      points: [0, 0, 10, 10],
      control: [5, 0],
      color: '#000',
      thickness: 2,
    }
    const moved = shiftDrawing(d, 3, -2)
    expect(moved.points).toEqual([3, -2, 13, 8])
    expect(moved.control).toEqual([8, -2])
  })
})

describe('shiftAttached', () => {
  const attached: Drawing = {
    id: 'a',
    type: 'arrow',
    points: [0, 0, 10, 10],
    color: '#000',
    thickness: 2,
    attachedTokenId: 'p1',
  }
  const loose: Drawing = { id: 'b', type: 'arrow', points: [0, 0, 5, 5], color: '#000', thickness: 2 }

  it('moves only the drawings attached to the moved tokens', () => {
    const out = shiftAttached([attached, loose], new Set(['p1']), 2, 2)
    expect(out[0].points).toEqual([2, 2, 12, 12])
    expect(out[1].points).toEqual([0, 0, 5, 5])
  })

  it('leaves everything alone when nothing is attached', () => {
    const input = [attached, loose]
    expect(shiftAttached(input, new Set(['other']), 5, 5)).toBe(input)
  })

  it('is a no-op for a zero delta', () => {
    const input = [attached, loose]
    expect(shiftAttached(input, new Set(['p1']), 0, 0)).toBe(input)
  })
})
