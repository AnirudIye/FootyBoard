import { describe, it, expect } from 'vitest'
import {
  createDrawing,
  isZone,
  isMark,
  isText,
  draftMode,
  shiftDrawing,
  shiftAttached,
} from './drawings'
import type { DrawStyle } from './drawings'
import { triangleFromDrag } from './geometry'
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
   * band a shape is painted in; the draft mode is what the press, the move and
   * the release all read to know which gesture is in flight, and a shape whose
   * mode is wrong is drawn to the screen and then silently thrown away.
   *
   * The triangle is a drag again — it was three clicks, one corner each — but a
   * drag out of a single planted apex, storing three corners rather than the
   * two ends of a box it stored the first time round.
   *
   * The polygon is the one tool that starts in `corners`, and it is the reason
   * this is a mode on a draft rather than a predicate over the type: it becomes
   * `free` the moment the hand travels. What is asserted here is only what the
   * press starts with. The draft is the authority after that, and
   * `useDrawGesture.test.ts` is where the change of mind is held.
   */
  it('starts each tool in the gesture its press means', () => {
    expect(draftMode('zoneTriangle')).toBe('apex')
    expect(draftMode('zonePoly')).toBe('corners')
    expect(draftMode('pen')).toBe('free')

    expect(draftMode('zoneRect')).toBe('drag')
    expect(draftMode('zoneEllipse')).toBe('drag')
    expect(draftMode('arrow')).toBe('drag')
    expect(draftMode('curvePass')).toBe('drag')
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
   * A triangle stores its three corners, worked out from the drag before it
   * ever reaches here. Nothing is derived on the way to the screen, which is
   * what lets a corner handle drag the number it is drawn on — and everything
   * that walks a point list (`shiftDrawing`, `shiftAttached`, `bboxOf`, the
   * selection outline) goes on treating it as a longer list rather than
   * acquiring a case.
   */
  it('stores a triangle as the three corners the drag produced', () => {
    const d = createDrawing('zoneTriangle', triangleFromDrag(10, 10, 40, 30), style)
    expect(d.points).toHaveLength(6)
    // The apex is the press point, carried through creation untouched.
    expect(d.points.slice(0, 2)).toEqual([10, 10])
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
