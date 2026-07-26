import type { Drawing, DrawingType } from './types'

/** Which way a curved pass or shot bends, seen from the passer. */
export type CurveDirection = 'left' | 'right'

export interface DrawStyle {
  color: string
  thickness: number
  fillOpacity: number
  curve: CurveDirection
}

const ZONE_TYPES: DrawingType[] = ['zoneRect', 'zoneEllipse', 'zonePoly']

/** Zones sit beneath the chips; everything else sits above them. */
export const isZone = (t: DrawingType): boolean => ZONE_TYPES.includes(t)
export const isText = (t: DrawingType): boolean => t === 'text'
export const isMark = (t: DrawingType): boolean => !isZone(t) && !isText(t)

/** Types whose gesture is a simple drag from one corner/end to another. */
export const isDragType = (t: DrawingType): boolean =>
  t === 'line' ||
  t === 'arrow' ||
  t === 'dashedArrow' ||
  t === 'curveArrow' ||
  t === 'curvePass' ||
  t === 'zoneRect' ||
  t === 'zoneEllipse'

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
