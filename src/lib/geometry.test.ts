import { describe, it, expect } from 'vitest'
import {
  clampNorm,
  dist,
  segmentDist,
  angleDeg,
  snapAngle,
  arrowHead,
  quadraticPoints,
  bboxOf,
  grabBox,
  triangleCorners,
  triangleFromDrag,
} from './geometry'

describe('geometry', () => {
  it('clamps norm coordinates to 0..100', () => {
    expect(clampNorm(-5, 120)).toEqual({ x: 0, y: 100 })
  })
  it('computes euclidean distance', () => {
    expect(dist(0, 0, 3, 4)).toBe(5)
  })
})

/**
 * The distance the eraser judges everything by, and the reason it is a segment
 * rather than a line.
 *
 * A mark on the board is a finite run of ink. The distance to the infinite line
 * it lies along is smaller than the distance to the mark for any point past its
 * ends, so a hit test built on the line would rub out a stroke on the halfway
 * line for a sweep down by the corner flag. The clamped cases below are that
 * bug, held.
 */
describe('segmentDist', () => {
  it('drops a perpendicular when the foot lands on the segment', () => {
    expect(segmentDist(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 9)
  })

  it('measures to the near end when the foot lands past it', () => {
    // Straight off the right-hand end: the perpendicular foot is at x=20 on the
    // line, which is not on the segment, so the answer is the distance to (10,0).
    expect(segmentDist(20, 0, 0, 0, 10, 0)).toBeCloseTo(10, 9)
    expect(segmentDist(-6, 8, 0, 0, 10, 0)).toBeCloseTo(10, 9)
  })

  it('answers nought for a point sitting on the ink', () => {
    expect(segmentDist(4, 4, 0, 0, 10, 10)).toBeCloseTo(0, 9)
  })

  it('answers a zero-length segment as the point it is', () => {
    // Two identical points, which every shape produces on the first frame of its
    // gesture. Projecting onto it would divide by nought and hand back a NaN,
    // and a NaN compares false against every radius there is.
    const d = segmentDist(3, 4, 0, 0, 0, 0)
    expect(d).toBeCloseTo(5, 9)
    expect(Number.isFinite(d)).toBe(true)
  })
})

/**
 * The on-canvas rotation gesture, held here because a Konva stage cannot mount
 * in jsdom — the same arrangement `triangleCorners` below is under.
 *
 * The cases that matter are the convention ones. Konva turns clockwise on a
 * screen whose y grows downward, so an angle that is "up" in school geometry is
 * "down" here, and getting that backwards is a prop that faces the wrong way
 * with nothing in the code to say which way was meant.
 */
describe('angleDeg', () => {
  it('reads 0 along +x, which is where a Konva node points unrotated', () => {
    expect(angleDeg(0, 0, 10, 0)).toBe(0)
  })

  it('turns clockwise on screen, because canvas y grows downward', () => {
    // Straight down the screen is a quarter turn *forward*, not backward.
    expect(angleDeg(0, 0, 0, 10)).toBeCloseTo(90, 9)
    expect(angleDeg(0, 0, -10, 0)).toBeCloseTo(180, 9)
    expect(angleDeg(0, 0, 0, -10)).toBeCloseTo(270, 9)
  })

  it('stays inside [0,360) rather than going negative', () => {
    // atan2 answers the upper half of the screen with negative radians.
    const up = angleDeg(50, 50, 60, 40)
    expect(up).toBeGreaterThanOrEqual(0)
    expect(up).toBeCloseTo(315, 9)
  })

  it('measures from the centre it is given, not from the origin', () => {
    expect(angleDeg(100, 100, 110, 110)).toBeCloseTo(45, 9)
  })

  it('answers the dead centre without flipping on a signed zero', () => {
    // Math.atan2(0, -0) is π. A spin dragged exactly through the middle would
    // otherwise jump half a turn on whichever frame landed on it.
    expect(angleDeg(0, 0, 0, 0)).toBe(0)
    expect(angleDeg(0, 0, -0, 0)).toBe(0)
  })
})

describe('snapAngle', () => {
  it('rounds to the nearest step', () => {
    expect(snapAngle(97, 15)).toBe(90)
    expect(snapAngle(98, 15)).toBe(105)
  })

  it('wraps the top of the circle back to nought', () => {
    // 358 rounds to 360, which is the same direction as 0 and not the same
    // number: stored, it is a Facing slider sitting past its own maximum.
    expect(snapAngle(358, 15)).toBe(0)
    expect(snapAngle(360, 15)).toBe(0)
  })

  it('wraps a negative angle round the other way', () => {
    expect(snapAngle(-10, 15)).toBe(345)
    expect(snapAngle(-370, 15)).toBe(345)
  })

  it('leaves the angle alone, wrapped, when there is no step to snap to', () => {
    expect(snapAngle(123.4, 0)).toBeCloseTo(123.4, 9)
    expect(snapAngle(-30, -1)).toBe(330)
  })
})

describe('arrowHead', () => {
  it('places both barbs behind the tip and symmetric about the shaft', () => {
    // Arrow pointing straight right, tip at (100, 0).
    const [ax, ay, bx, by] = arrowHead(0, 0, 100, 0, 10)
    expect(ax).toBeLessThan(100)
    expect(bx).toBeLessThan(100)
    expect(ax).toBeCloseTo(bx, 6)
    expect(ay).toBeCloseTo(-by, 6)
  })

  it('follows the direction of the shaft', () => {
    // Arrow pointing straight down, tip at (0, 100).
    const [ax, ay, bx, by] = arrowHead(0, 0, 0, 100, 10)
    expect(ay).toBeLessThan(100)
    expect(by).toBeLessThan(100)
    expect(ax).toBeCloseTo(-bx, 6)
  })

  it('returns the tip itself for a zero-length shaft', () => {
    const pts = arrowHead(50, 50, 50, 50, 10)
    expect(pts).toHaveLength(4)
    expect(pts.every((n) => Number.isFinite(n))).toBe(true)
  })
})

describe('quadraticPoints', () => {
  it('starts at the start and ends at the end', () => {
    const pts = quadraticPoints(0, 0, 50, 100, 100, 0, 16)
    expect(pts[0]).toBeCloseTo(0, 6)
    expect(pts[1]).toBeCloseTo(0, 6)
    expect(pts[pts.length - 2]).toBeCloseTo(100, 6)
    expect(pts[pts.length - 1]).toBeCloseTo(0, 6)
  })

  it('bulges toward the control point', () => {
    const pts = quadraticPoints(0, 0, 50, 100, 100, 0, 16)
    const midY = pts[pts.length / 2 + 1]
    expect(midY).toBeGreaterThan(20)
  })

  it('emits the requested number of samples', () => {
    expect(quadraticPoints(0, 0, 5, 5, 10, 0, 8)).toHaveLength((8 + 1) * 2)
  })
})

describe('bboxOf', () => {
  it('bounds every point', () => {
    const box = bboxOf([10, 20, 40, 5, 25, 60])
    expect(box).toEqual({ x: 10, y: 5, w: 30, h: 55 })
  })
  it('handles a single point', () => {
    expect(bboxOf([7, 9])).toEqual({ x: 7, y: 9, w: 0, h: 0 })
  })
})

describe('grabBox', () => {
  it('pads a box that is already big enough, and nothing more', () => {
    expect(grabBox({ x: 0, y: 0, w: 100, h: 80 }, 5, 44)).toEqual({
      x: -5,
      y: -5,
      w: 110,
      h: 90,
    })
  })

  it('lifts a thin shape to the floor on the axis that needs it', () => {
    // A directional marker: long, and a stroke thick. Padding alone leaves it
    // a few pixels tall, which is the whole reason props are hard to pick up.
    const grown = grabBox({ x: -20, y: -1.5, w: 40, h: 3 }, 2, 44)
    expect(grown.w).toBe(44)
    expect(grown.h).toBe(44)
  })

  it('grows about the centre, so the target still sits on the thing', () => {
    const box = { x: 10, y: 40, w: 4, h: 4 }
    const grown = grabBox(box, 1, 44)
    expect(grown.x + grown.w / 2).toBeCloseTo(box.x + box.w / 2, 9)
    expect(grown.y + grown.h / 2).toBeCloseTo(box.y + box.h / 2, 9)
  })

  it('never comes back smaller than what was painted', () => {
    // The floor is a floor. A prop drawn larger than a finger keeps its own
    // extent rather than being cropped down to 44.
    const grown = grabBox({ x: -60, y: -60, w: 120, h: 120 }, 0, 44)
    expect(grown).toEqual({ x: -60, y: -60, w: 120, h: 120 })
  })
})

/**
 * The triangle a drag actually produces, asserted here rather than through a
 * mounted stage, for the reason `dragChip` is exported from `PlayerChip` and
 * `onScreen` from `TokenLayer`: the rule is worth holding on its own, and a
 * Konva canvas in jsdom would only be in the way of holding it.
 *
 * Four properties, and each one is a way the gesture goes wrong if it slips.
 * The apex must be the press point or the shape walks away from the spot the
 * coach chose. The base must be perpendicular or a triangle dragged diagonally
 * comes out skewed. The base must equal the drag or the shape is not the same
 * shape at two sizes. And the zero-length case is asked for on the first frame
 * of every triangle ever drawn, so it cannot be allowed to produce a NaN that
 * would poison `points` and travel to every peer in the room.
 */
describe('triangleFromDrag', () => {
  it('plants the apex exactly where the press landed', () => {
    const t = triangleFromDrag(20, 30, 60, 70)
    expect(t[0]).toBe(20)
    expect(t[1]).toBe(30)
  })

  it('lays the base perpendicular to the drag', () => {
    // Dragged down and to the right, so nothing is axis-aligned and a sign
    // error cannot hide behind a zero.
    const [ax, ay, bax, bay, bbx, bby] = triangleFromDrag(10, 10, 40, 50)
    const drag = [40 - ax, 50 - ay]
    const base = [bbx - bax, bby - bay]
    expect(drag[0] * base[0] + drag[1] * base[1]).toBeCloseTo(0, 9)
  })

  it('makes the base as long as the drag, so the shape is one shape at any size', () => {
    // 30 across and 40 down is a drag of 50.
    const t = triangleFromDrag(10, 10, 40, 50)
    expect(dist(t[2], t[3], t[4], t[5])).toBeCloseTo(50, 9)
  })

  it('centres the base on the pointer, so the triangle grows under the finger', () => {
    const t = triangleFromDrag(10, 10, 40, 50)
    expect((t[2] + t[4]) / 2).toBeCloseTo(40, 9)
    expect((t[3] + t[5]) / 2).toBeCloseTo(50, 9)
  })

  it('collapses a drag that never moved, with nothing non-finite in it', () => {
    const t = triangleFromDrag(50, 50, 50, 50)
    expect(t).toEqual([50, 50, 50, 50, 50, 50])
    expect(t.every((n) => Number.isFinite(n))).toBe(true)
  })
})

/**
 * The legacy shim, held to what it does because `DrawingShape` still calls it
 * for a triangle stored as the two ends of a drag. It is not how a triangle is
 * made — that is `triangleFromDrag` above — and these tests go when it does.
 */
describe('triangleCorners', () => {
  it('centres the apex on the edge the drag started from', () => {
    // Dragged down and to the right from (0,0): apex on top, base on the floor.
    expect(triangleCorners(0, 0, 10, 20)).toEqual([5, 0, 0, 20, 10, 20])
  })

  it('inverts when the drag runs the other way, so a triangle can point down', () => {
    // The same box, dragged bottom-left to top-right. The apex stays with the
    // start, which is the whole of how a coach points one downwards.
    const t = triangleCorners(0, 20, 10, 0)
    expect(t).toEqual([5, 20, 0, 0, 10, 0])
    expect(t[1]).toBeGreaterThan(t[3])
  })

  it('fills exactly the box the drag described', () => {
    // What the selection outline is drawn from: it bounds the two drag points,
    // so the triangle has to reach all four sides of them or the dashed box
    // would sit off the shape it is marking.
    const drag = [12, 30, 48, 6]
    const corners = triangleCorners(drag[0], drag[1], drag[2], drag[3])
    expect(bboxOf(corners)).toEqual(bboxOf(drag))
  })

  it('survives a degenerate drag without producing anything non-finite', () => {
    const t = triangleCorners(50, 50, 50, 50)
    expect(t).toHaveLength(6)
    expect(t.every((n) => Number.isFinite(n))).toBe(true)
  })
})
