import { clamp } from './math'

export interface PitchBox {
  x: number
  y: number
  w: number
  h: number
}

export const clampNorm = (nx: number, ny: number) => ({
  x: clamp(nx, 0, 100),
  y: clamp(ny, 0, 100),
})

export const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(bx - ax, by - ay)

const HEAD_SPREAD = Math.PI / 7

/**
 * The two barb points of an arrowhead whose tip is at (toX,toY), pointing away
 * from (fromX,fromY). Returned flat as [ax, ay, bx, by].
 */
export function arrowHead(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  size: number,
): number[] {
  const angle = Math.atan2(toY - fromY, toX - fromX)
  if (!Number.isFinite(angle) || (toX === fromX && toY === fromY)) {
    return [toX, toY, toX, toY]
  }
  return [
    toX - size * Math.cos(angle - HEAD_SPREAD),
    toY - size * Math.sin(angle - HEAD_SPREAD),
    toX - size * Math.cos(angle + HEAD_SPREAD),
    toY - size * Math.sin(angle + HEAD_SPREAD),
  ]
}

/** Flattened polyline sampling a quadratic bezier, inclusive of both ends. */
export function quadraticPoints(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  steps = 20,
): number[] {
  const out: number[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const inv = 1 - t
    out.push(
      inv * inv * x0 + 2 * inv * t * cx + t * t * x1,
      inv * inv * y0 + 2 * inv * t * cy + t * t * y1,
    )
  }
  return out
}

/**
 * The three corners of a triangular zone, from the two corners of the drag that
 * made it. Returned flat as [apexX, apexY, ...base], apex first.
 *
 * A triangle is stored the way a box and an oval are — the two points of the
 * drag, nothing else — and grows its third corner here, on the way to the
 * screen. That is not a saving of eight bytes. Every dragged zone then has the
 * same four numbers in `points`, so `shiftDrawing`, `shiftAttached`, the
 * marquee and the selection outline go on treating them alike instead of
 * acquiring a case, and the outline in particular comes out right for free:
 * `bboxOf` of the drag is exactly the box this fills.
 *
 * **The apex stays with the start of the drag**, which is the one place a
 * triangle differs from the two symmetric shapes beside it and the reason this
 * does not normalise the box first. A box dragged up-right and a box dragged
 * down-left are the same box, so `zoneRect` may take `Math.min` and lose the
 * direction; a triangle dragged the other way is a triangle pointing the other
 * way, and a coach drawing a funnel back towards their own goal wants that.
 * Drag from the point towards the base and the shape follows the hand.
 *
 * Only the vertical axis, deliberately. A rule that also aimed the apex left or
 * right would have to decide which delta dominates, which makes the shape flip
 * under a hand that wobbles near the diagonal — and a sideways triangle is not
 * what the pressing traps and passing triangles this is for are drawn as.
 */
export function triangleCorners(x0: number, y0: number, x1: number, y1: number): number[] {
  return [(x0 + x1) / 2, y0, x0, y1, x1, y1]
}

/** Axis-aligned bounds of a flat [x,y,...] point list. */
export function bboxOf(points: number[]): PitchBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i])
    maxX = Math.max(maxX, points[i])
    minY = Math.min(minY, points[i + 1])
    maxY = Math.max(maxY, points[i + 1])
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
