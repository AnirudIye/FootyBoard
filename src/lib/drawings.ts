import type { Drawing, DrawingType } from './types'

/** Which way a curved pass or shot bends, seen from the passer. */
export type CurveDirection = 'left' | 'right'

export interface DrawStyle {
  color: string
  thickness: number
  fillOpacity: number
  curve: CurveDirection
}

const ZONE_TYPES: DrawingType[] = ['zoneRect', 'zoneEllipse', 'zoneTriangle', 'zonePoly']

/** Zones sit beneath the chips; everything else sits above them. */
export const isZone = (t: DrawingType): boolean => ZONE_TYPES.includes(t)
export const isText = (t: DrawingType): boolean => t === 'text'
export const isMark = (t: DrawingType): boolean => !isZone(t) && !isText(t)

/**
 * Types whose gesture is a simple drag from one corner/end to another.
 *
 * Separate from `isZone` on purpose, and the two overlap without either
 * implying the other: `zonePoly` is a zone that is not dragged, `arrow` is
 * dragged and is not a zone. Being a zone decides which band a shape is painted
 * in; being a drag type is what makes the pointer release commit one at all.
 */
export const isDragType = (t: DrawingType): boolean =>
  t === 'line' ||
  t === 'arrow' ||
  t === 'dashedArrow' ||
  t === 'curveArrow' ||
  t === 'curvePass' ||
  t === 'zoneRect' ||
  t === 'zoneEllipse'

/**
 * Types placed by clicking their corners rather than dragging a box.
 *
 * The complement of `isDragType` among the shapes, and named rather than
 * spelled out at each site because three places in `useDrawGesture` ask the same
 * question: which pointer-down starts or extends a shape, which pointer-move
 * must *not* rubber-band a second corner, and which pointer-up must leave the
 * draft standing instead of committing it. Those three answers have to agree, and
 * a shape that is a click type to one of them and not to the others is a gesture
 * that half works.
 *
 * The two differ only in when they end. A polygon takes as many corners as you
 * give it and closes on Enter; a triangle closes itself on the third, because
 * three is the whole of what a triangle is and asking for a keystroke as well
 * would be asking twice.
 */
export const isClickType = (t: DrawingType): boolean =>
  t === 'zonePoly' || t === 'zoneTriangle'

/** Corners a click-placed shape needs before it becomes one, or 0 for no limit. */
export const CLICK_CORNERS: Partial<Record<DrawingType, number>> = { zoneTriangle: 3 }

/** Curved types share a control point and a bend direction. */
export const isCurve = (t: DrawingType): boolean => t === 'curveArrow' || t === 'curvePass'

/**
 * Control point for a curve: the midpoint pushed out perpendicular to the
 * line, on the side the coach asked for. Left and right are from the point of
 * view of someone standing at the start looking down the pass.
 */
export function curveControl(
  points: number[],
  direction: CurveDirection,
  bend = 0.25,
): number[] {
  const [x0, y0, x1, y1] = points
  const sign = direction === 'right' ? -1 : 1
  return [
    (x0 + x1) / 2 + (y1 - y0) * bend * sign,
    (y0 + y1) / 2 - (x1 - x0) * bend * sign,
  ]
}

export interface CreateExtra {
  text?: string
  control?: number[]
}

export function createDrawing(
  type: DrawingType,
  points: number[],
  style: DrawStyle,
  extra: CreateExtra = {},
): Omit<Drawing, 'id'> {
  const base: Omit<Drawing, 'id'> = {
    type,
    points: [...points],
    color: style.color,
    thickness: style.thickness,
  }
  if (isZone(type)) return { ...base, fillOpacity: style.fillOpacity }
  if (type === 'dashedArrow') return { ...base, dashed: true }
  if (type === 'text') return { ...base, text: extra.text ?? '' }
  if (isCurve(type)) {
    // Bend it straight away, so a fresh curve reads as a curve rather than a
    // straight line waiting to be dragged.
    return {
      ...base,
      control: extra.control ?? curveControl(points, style.curve),
      ...(type === 'curvePass' ? { dashed: true } : {}),
    }
  }
  return base
}

/** Translate every point (and any control point) of a drawing. */
export function shiftDrawing(d: Drawing, dx: number, dy: number): Drawing {
  const points = d.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
  const control = d.control?.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
  return control ? { ...d, points, control } : { ...d, points }
}

/** Shift only the drawings attached to one of `tokenIds`. */
export function shiftAttached(
  drawings: Drawing[],
  tokenIds: Set<string>,
  dx: number,
  dy: number,
): Drawing[] {
  if (dx === 0 && dy === 0) return drawings
  let changed = false
  const next = drawings.map((d) => {
    if (!d.attachedTokenId || !tokenIds.has(d.attachedTokenId)) return d
    changed = true
    return shiftDrawing(d, dx, dy)
  })
  return changed ? next : drawings
}
