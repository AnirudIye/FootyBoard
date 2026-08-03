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
 * How a draft behaves between the press that starts it and the release that
 * ends it.
 *
 * - `drag` — two points, the second following the pointer. Line, run, pass,
 *   both curves, box, oval.
 * - `apex` — the triangle. The press plants the apex and the drag grows the
 *   base away from it, so the draft holds all three corners from the first
 *   frame and what is previewed is exactly what will be committed.
 * - `free` — points appended as the pointer travels: the pen, and the polygon
 *   while it is being traced.
 * - `corners` — points placed one press at a time, and the only mode whose
 *   draft outlives the release. Only the polygon, and only until it travels.
 *
 * **This rides on the draft, not on the type**, which is the whole reason it
 * exists rather than staying a pair of predicates over `DrawingType`. The
 * polygon is a traced shape or a clicked one depending on whether the hand
 * moved, and no function of the type can answer that.
 */
export type DraftMode = 'drag' | 'apex' | 'free' | 'corners'

/**
 * The mode a tool's gesture starts in. The draft carries the answer from there.
 *
 * Three places in `useDrawGesture` have to agree about a shape in flight: which
 * press starts or extends it, whether a move may rewrite points somebody
 * already placed, and whether the release commits it or leaves the draft
 * standing. They used to agree by each asking the type the same question, which
 * worked only while every shape's gesture was fixed at the moment it was armed.
 * The polygon's is not, so the type is asked once — here, at the press — and
 * the move and the release read the mode off the draft instead of deriving it
 * again. A shape that is one kind to one of those three call sites and another
 * kind to the others is a gesture that half works, and one answer in one place
 * is what stops that happening.
 *
 * Separate from `isZone`, and neither implies the other: `zonePoly` is a zone
 * that may be traced or clicked, `arrow` is dragged and is not a zone. Being a
 * zone decides which band a shape is painted in; the mode is what makes a
 * release commit one at all.
 *
 * `text` never reaches this. Its press opens a DOM input and returns before any
 * draft exists, so the `drag` it nominally falls to is never used.
 */
export const draftMode = (t: DrawingType): DraftMode =>
  t === 'zoneTriangle' ? 'apex' : t === 'pen' ? 'free' : t === 'zonePoly' ? 'corners' : 'drag'

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
