import { clamp } from './math'

export interface PitchBox {
  x: number
  y: number
  w: number
  h: number
}

export const normToPx = (nx: number, ny: number, b: PitchBox) => ({
  x: b.x + (nx / 100) * b.w,
  y: b.y + (ny / 100) * b.h,
})

export const pxToNorm = (px: number, py: number, b: PitchBox) => ({
  x: ((px - b.x) / b.w) * 100,
  y: ((py - b.y) / b.h) * 100,
})

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

/** Whether (px,py) lies within `tolerance` of the segment a-b. */
export function pointNearSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tolerance: number,
): boolean {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return dist(px, py, ax, ay) <= tolerance
  // Project onto the segment, clamped so the ends do not extend forever.
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1)
  return dist(px, py, ax + t * dx, ay + t * dy) <= tolerance
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
