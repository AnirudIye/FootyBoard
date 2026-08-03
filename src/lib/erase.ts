import type { Drawing } from './types'
import { dist, quadraticPoints, segmentDist, triangleCorners } from './geometry'

/**
 * Which drawings a disc of `radius` centred on (nx,ny) is touching.
 *
 * Everything here is in board units — a hundredth of the pitch length in x and a
 * hundredth of its width in y — because that is what a drawing stores and it is
 * the only frame in which this can be a pure function. Turning the eraser's
 * size in CSS pixels into a number of board units is the caller's job, and it
 * needs the live mapping and zoom to do it; see `PitchCanvas`.
 *
 * **Touching, not containing.** A zone is erased by dragging over its fill or
 * over its edge, a stroke by dragging over the ink. That is what an eraser means
 * to a hand, and it is why every branch below is a distance to the *painted*
 * geometry rather than a bounding-box test — a bounding box would take an arrow
 * off the board for a sweep that passed a long way from it, diagonally.
 */
export function hitDrawings(
  drawings: Drawing[],
  nx: number,
  ny: number,
  radius: number,
): string[] {
  return drawings.filter((d) => touches(d, nx, ny, radius)).map((d) => d.id)
}

const touches = (d: Drawing, nx: number, ny: number, r: number): boolean => {
  const p = d.points
  switch (d.type) {
    case 'pen':
    case 'line':
    case 'arrow':
    case 'dashedArrow':
      return polylineDist(p, nx, ny) <= r

    // Sampled with the very function that draws it, so what the eraser tests
    // against is the bow and not the chord under it — a bent pass can bow
    // several metres away from the straight line between its ends, which is the
    // entire point of it. The sample count is `quadraticPoints`' own default
    // rather than the 24 `DrawingShape` asks for, and it does not need to match:
    // both flatten the same curve, and the difference between the two chordal
    // approximations is far under a board unit. What does have to match is the
    // fallback for a curve carrying no control point, which is the midpoint in
    // both places — otherwise the eraser would be testing a shape nobody drew.
    case 'curveArrow':
    case 'curvePass': {
      const [x0, y0, x1, y1] = p
      const cx = d.control ? d.control[0] : (x0 + x1) / 2
      const cy = d.control ? d.control[1] : (y0 + y1) / 2
      return polylineDist(quadraticPoints(x0, y0, cx, cy, x1, y1), nx, ny) <= r
    }

    // Stored as the two ends of a drag, so the corners come from min/max rather
    // than from the order they were dragged in. Inside answers zero, which is
    // what makes one expression cover both the fill and the edge.
    case 'zoneRect': {
      const [x0, y0, x1, y1] = p
      const dx = Math.max(Math.min(x0, x1) - nx, 0, nx - Math.max(x0, x1))
      const dy = Math.max(Math.min(y0, y1) - ny, 0, ny - Math.max(y0, y1))
      return Math.hypot(dx, dy) <= r
    }

    case 'zoneEllipse': {
      const [x0, y0, x1, y1] = p
      const rx = Math.abs(x1 - x0) / 2
      const ry = Math.abs(y1 - y0) / 2
      // A drag that never opened out on one axis is a line, not an ellipse, and
      // the radial test below would divide by nought. Treat it as the segment it
      // looks like.
      if (rx === 0 || ry === 0) return polylineDist(p, nx, ny) <= r
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      const k = Math.hypot((nx - cx) / rx, (ny - cy) / ry)
      if (k <= 1) return true
      /**
       * Outside: the distance to the point where the ray from the centre leaves
       * the ellipse. That is not the *closest* point on the ellipse — the true
       * foot of the perpendicular is nearer — so this reads slightly further
       * than the truth and the eraser reaches slightly less far than its disc
       * suggests near a flat flank. Erring that way is deliberate: an eraser
       * that takes a shape you did not cover is a worse surprise than one that
       * needs half a centimetre more, and the exact answer is a quartic.
       */
      return dist(nx, ny, cx + (nx - cx) / k, cy + (ny - cy) / k) <= r
    }

    case 'zoneTriangle':
    case 'zonePoly': {
      // The four-number arm is the legacy triangle `DrawingShape` still draws
      // through `triangleCorners`: a shape stored as the two ends of a drag. It
      // has to be erased as the triangle it is painted as, or the one shape on
      // the board that cannot be redrawn would also be the one that cannot be
      // rubbed out. Both go together when that shim does.
      const corners =
        d.type === 'zoneTriangle' && p.length === 4
          ? triangleCorners(p[0], p[1], p[2], p[3])
          : p
      if (pointInPolygon(corners, nx, ny)) return true
      return closedEdgeDist(corners, nx, ny) <= r
    }

    /**
     * A box of one erase radius about the anchor, which is a smaller target than
     * the words look.
     *
     * A label's painted extent is not in the data: `points` is the one point the
     * label hangs from, the glyphs are laid out by Konva at a font size derived
     * from the pitch, and none of that is knowable from a `Drawing`. So this
     * stays honest about what it does know rather than guessing a box around
     * text it cannot measure — guessing long would erase labels a sweep only
     * passed *near*, and a coach who means this one aims at it.
     */
    case 'text':
      return Math.abs(nx - p[0]) <= r && Math.abs(ny - p[1]) <= r
  }
}

/**
 * The nearest approach to an open run of points.
 *
 * A single point is a stroke that has not gone anywhere yet, and it still has to
 * answer a distance rather than `Infinity`, or the very first frame of a pen
 * stroke would be unerasable.
 */
function polylineDist(points: number[], nx: number, ny: number): number {
  if (points.length < 4) return dist(nx, ny, points[0], points[1])
  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    best = Math.min(best, segmentDist(nx, ny, points[i], points[i + 1], points[i + 2], points[i + 3]))
  }
  return best
}

/** The nearest approach to a closed run of points: every edge, plus the one back to the start. */
function closedEdgeDist(points: number[], nx: number, ny: number): number {
  const n = points.length / 2
  if (n < 2) return dist(nx, ny, points[0], points[1])
  let best = Infinity
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    best = Math.min(
      best,
      segmentDist(nx, ny, points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1]),
    )
  }
  return best
}

/**
 * Ray casting: count the edges a ray from the point crosses, odd means inside.
 *
 * The half-open comparison `(yi > ny) !== (yj > ny)` is the part worth keeping
 * exactly as written. It counts an edge only if the ray passes its lower end and
 * not its upper one, so a ray that leaves the shape exactly through a vertex
 * crosses the two edges meeting there once between them rather than twice or not
 * at all — which is the classic way this test reports a point inside a triangle
 * as outside, and only for pointers that happen to land level with a corner.
 */
function pointInPolygon(points: number[], nx: number, ny: number): boolean {
  const n = points.length / 2
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2]
    const yi = points[i * 2 + 1]
    const xj = points[j * 2]
    const yj = points[j * 2 + 1]
    if (yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
