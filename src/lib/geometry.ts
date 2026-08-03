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

/**
 * The distance from (px,py) to the *segment* between (ax,ay) and (bx,by) — not
 * to the infinite line through them.
 *
 * That difference is the whole reason this exists. Every mark on the board is a
 * finite run of segments, and the distance to the line they lie on is smaller
 * than the distance to the mark itself for any point off the ends: a pen stroke
 * across the halfway line would answer "you are touching me" to a pointer parked
 * on the corner flag, because the corner is close to the line the stroke happens
 * to lie along. Projecting and then clamping the parameter to [0,1] is what
 * keeps the answer about the ink that was actually painted.
 *
 * A zero-length segment — two identical points, which a shape mid-gesture really
 * does produce — has no direction to project onto, so it is answered as the
 * distance to the point. Without that, `len2` is nought and the parameter is a
 * NaN that would propagate through every comparison as `false`.
 */
export function segmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(px, py, ax, ay)
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
  return dist(px, py, ax + t * dx, ay + t * dy)
}

/**
 * The angle from (cx,cy) to (px,py), in degrees in [0,360), measured from +x.
 *
 * **This is Konva's rotation convention, and it is not the one school geometry
 * teaches.** A node's transform sends its own +x axis to (cos θ, sin θ) in its
 * parent — that is `Transform.rotate` in konva/lib/Util.js, which builds
 * [c, s, -s, c], and it was read rather than assumed — and canvas y grows
 * downward, so a positive angle turns clockwise on screen. The useful
 * consequence is that `atan2(dy, dx)` in degrees is already the number to write
 * into `rotation`: no sign flip, no quarter turn, and anything a token draws
 * along its own +x axis ends up pointing at the pointer.
 *
 * A pointer sitting exactly on the centre is answered as 0 rather than left to
 * `atan2`, which is not a guard against nonsense but against a real
 * discontinuity: `Math.atan2(0, -0)` is π and `Math.atan2(0, 0)` is 0, so a
 * spin dragged through the dead centre would flip half a turn on whichever
 * frame the two coordinates happened to land exactly.
 */
export function angleDeg(cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx
  const dy = py - cy
  if (dx === 0 && dy === 0) return 0
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI
  return deg < 0 ? deg + 360 : deg
}

/**
 * Round an angle to the nearest multiple of `step`, staying inside [0,360).
 *
 * The wrap is the point rather than a tidy-up. 358 snapped to 15 rounds to 360,
 * which is the same direction as 0 and a different number, and 360 in the store
 * is a token whose Facing slider sits one stop past its own maximum. Negative
 * input wraps the same way, so a caller may hand this a raw `atan2` result.
 *
 * A step of zero or less is a caller asking for no snapping at all; it gets the
 * angle back, wrapped, rather than a division by nought.
 */
export function snapAngle(deg: number, step: number): number {
  const wrap = (d: number) => ((d % 360) + 360) % 360
  if (!(step > 0)) return wrap(deg)
  return wrap(Math.round(deg / step) * step)
}

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
 * The three corners of a triangle grown out of a drag, flat as
 * [apexX, apexY, baseAX, baseAY, baseBX, baseBY].
 *
 * The apex is exactly where the press landed and the base is perpendicular to
 * the drag, centred on the pointer and as long as the drag itself. So the
 * triangle grows out of the one point the coach chose deliberately, points back
 * the way the hand came from, and is the same isoceles shape at every size —
 * there is no aspect ratio to lose control of halfway through a gesture, which
 * is what made the two-corner box version hard to aim.
 *
 * The base half-width is *half the drag* rather than a constant. A constant
 * would make a short drag a fat wedge and a long one a needle, and both ends of
 * that range are shapes nobody was reaching for.
 *
 * **The three corners are what gets stored**, unlike the four-number drag a box
 * and an oval keep. This runs on every pointermove to grow the draft and never
 * on the way from the store to the screen, which is what lets a corner handle
 * be honest: the handle drags the very number it is drawn on. It is also why
 * `shiftDrawing`, `shiftAttached`, the marquee and the selection outline needed
 * no case for it — they walk a flat point list and six numbers is a longer one.
 *
 * There is no division here and so nothing to guard: the drag length cancels
 * out of "unit perpendicular times half the length", leaving the drag turned a
 * quarter turn and halved. A drag that has not moved therefore collapses to
 * three copies of the press point, every one of them finite, which matters
 * because the preview asks for exactly that on the first frame of every
 * triangle ever drawn.
 */
export function triangleFromDrag(x0: number, y0: number, x1: number, y1: number): number[] {
  const hx = (y0 - y1) / 2
  const hy = (x1 - x0) / 2
  return [x0, y0, x1 + hx, y1 + hy, x1 - hx, y1 - hy]
}

/**
 * The three corners of a triangle stored as the two corners of a box, apex
 * centred on the edge the drag started from. Returned flat, apex first.
 *
 * **This is a shim and nothing else.** A triangle stored its drag and grew its
 * apex on the way to the screen for a few hours, before either that design or
 * the three-click one that replaced it had reached anybody; today one is placed
 * by a drag again and stores its three corners outright, through
 * `triangleFromDrag`. What is left are the two four-number arms that keep such a
 * shape usable: `DrawingShape` paints it as a triangle rather than as a stray
 * two-point line — quiet wrongness being much harder to trace back than a
 * missing shape — and `erase.ts` rubs it out as the triangle it is painted as,
 * so the one shape that cannot be redrawn is not also the one that cannot be
 * removed.
 *
 * It can go, along with both of those arms and the tests below it, as soon as
 * the dev database is known not to hold one. Nothing produces such a shape now.
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

/**
 * A box grown about its own centre until it is something a person can hit:
 * `pad` on every side, and then whatever more it takes for neither side to be
 * under `min`.
 *
 * The two steps are not the same step. The padding is proportional — it keeps
 * the target a little bigger than the thing it stands for at any pitch size, so
 * a cone on a futsal court and a cone on a full pitch both have a little air
 * around them. The floor is absolute, and it is what makes a marker with a 3px
 * painted line catchable at all.
 *
 * The units are whatever the caller is working in. A caller sizing a canvas
 * target in screen terms has to divide `min` by the live zoom first, because a
 * stage scaled by pan and zoom draws a box of side `s` at `s * zoom` CSS pixels
 * and it is the pixels a finger is measured in.
 */
export function grabBox(box: PitchBox, pad: number, min: number): PitchBox {
  const w = Math.max(box.w + pad * 2, min)
  const h = Math.max(box.h + pad * 2, min)
  return { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h }
}
