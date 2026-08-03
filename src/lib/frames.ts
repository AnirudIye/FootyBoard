import type { Token, Frame, FrameTokenState } from './types'
import { clamp, lerp } from './math'

/**
 * How long one frame-to-frame move takes at speed 1.
 *
 * It lives here rather than in the playback hook because the exporters need the
 * same number: a GIF whose timing disagreed with the board it was recorded from
 * is a sequence people would have to re-time by eye.
 */
export const SECONDS_PER_FRAME = 1.1

/**
 * The most frames one sequence may hold.
 *
 * Nothing bounded this before, and everything downstream of it is linear in the
 * count: the storyboard is `(n - 1) * SECONDS_PER_FRAME` seconds long, each
 * captured frame adds a chip to the strip, each is a snapshot of every token in
 * the undo stack and in the saved board, and each lengthens the export. Twenty
 * is 20.9 seconds of movement, which is longer than any single passage of play
 * a tactics board is used to describe — and it is also the figure the GIF work
 * kept quoting as the worst case it had to defend against, so making it the
 * actual ceiling is what turns that defence into an argument about a bounded
 * range rather than an open one.
 *
 * The exporters keep their own caps and still need them: this bounds the
 * *storyboard*, and `gifSteps` bounds the frames written *between* its poses,
 * which is a different number and a much larger one.
 */
export const MAX_FRAMES = 20

/** Snapshot the positions of every token on the board. */
export function captureFrame(tokens: Token[]): Record<string, FrameTokenState> {
  const out: Record<string, FrameTokenState> = {}
  for (const t of tokens) out[t.id] = { x: t.x, y: t.y, rotation: t.rotation }
  return out
}

/**
 * Ease the whole timeline, once.
 *
 * The version this replaces eased each segment separately, which meant tokens
 * came to a complete stop at every captured frame and set off again — the
 * toggle meant to make movement look natural was the one that made it pulse,
 * and that pulse is what got exported to GIF and video.
 *
 * The shape is a trapezoid: accelerate over the first segment, hold a constant
 * speed through the middle, decelerate over the last. With only one or two
 * segments there is no middle to hold, and the ramps meet at the halfway point
 * — which reduces exactly to the cubic ease-in-out that was here before, so a
 * two-frame sequence is unchanged.
 *
 * `u` and the result are both fractions of the whole sequence, 0 to 1.
 */
function easeTimeline(u: number, segments: number): number {
  // The ramps take one segment each, or half the timeline when there is not
  // enough of it to give them a segment apiece.
  const r = Math.min(1, segments / 2) / segments
  // Speed through the plateau. Each ramp covers `v * r / 3` of the distance
  // (the ramp is quadratic in speed, so it averages a third of the plateau),
  // and the three parts have to add up to the whole sequence.
  const v = 1 / (1 - (4 * r) / 3)

  if (u <= r) {
    const s = u / r
    return (v * r * s * s * s) / 3
  }
  if (u >= 1 - r) {
    const s = (1 - u) / r
    return 1 - (v * r * s * s * s) / 3
  }
  return (v * r) / 3 + v * (u - r)
}

interface Pt {
  x: number
  y: number
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })

/**
 * A player's position part-way between two waypoints, on a curve through them.
 *
 * Centripetal Catmull-Rom: the knots are spaced by the square root of each
 * chord rather than uniformly, which is what stops the curve looping back on
 * itself when two waypoints sit close together. Read on a pitch, a uniform
 * spline's loop looks like a player taking a step backwards before setting off.
 *
 * The ends take the chord itself as their tangent instead of a reflected
 * neighbour. A reflected tangent is what makes a spline bow outward past its
 * first and last points, and past the first and last points here is off the
 * pitch.
 */
function curveBetween(
  before: Pt | undefined,
  from: Pt,
  to: Pt,
  after: Pt | undefined,
  s: number,
): Pt {
  const d = sub(to, from)
  const chord = Math.hypot(d.x, d.y)
  // Two identical waypoints have no direction to curve along.
  if (chord === 0) return { x: from.x, y: from.y }

  const b = Math.sqrt(chord)
  const a = before ? Math.sqrt(Math.hypot(from.x - before.x, from.y - before.y)) : 0
  const c = after ? Math.sqrt(Math.hypot(after.x - to.x, after.y - to.y)) : 0

  // Tangents at each end, already scaled into this segment's parameter. With no
  // usable neighbour they fall back to the chord, which is the straight line.
  const t1 =
    before && a > 0
      ? {
          x: d.x * (a / (a + b)) + (from.x - before.x) * ((b * b) / (a * (a + b))),
          y: d.y * (a / (a + b)) + (from.y - before.y) * ((b * b) / (a * (a + b))),
        }
      : d
  const t2 =
    after && c > 0
      ? {
          x: (after.x - to.x) * ((b * b) / (c * (b + c))) + d.x * (c / (b + c)),
          y: (after.y - to.y) * ((b * b) / (c * (b + c))) + d.y * (c / (b + c)),
        }
      : d

  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2

  return {
    x: h00 * from.x + h10 * t1.x + h01 * to.x + h11 * t2.x,
    y: h00 * from.y + h10 * t1.y + h01 * to.y + h11 * t2.y,
  }
}

/**
 * Positions to draw the tokens at for a fractional playhead `t` in
 * [0, frames.length-1]. Tokens absent from the surrounding frames keep their
 * live board position, so props added after a frame was captured do not jump.
 *
 * `eased` shapes the *timing* across the whole sequence. The path itself is
 * always a curve through the waypoints, because a player rounds a marker rather
 * than arriving at it and turning on the spot.
 */
export function interpolateFrames(
  frames: Frame[],
  tokens: Token[],
  t: number,
  eased = false,
): Record<string, FrameTokenState> {
  const live = captureFrame(tokens)
  if (frames.length === 0) return live
  if (frames.length === 1) return { ...live, ...frames[0].tokens }

  const segments = frames.length - 1
  const clamped = clamp(t, 0, segments)
  const pos = eased ? easeTimeline(clamped / segments, segments) * segments : clamped
  const i = Math.min(Math.floor(pos), segments - 1)
  const frac = pos - i

  const a = frames[i].tokens
  const b = frames[i + 1].tokens
  const before = i > 0 ? frames[i - 1].tokens : undefined
  const after = i + 2 < frames.length ? frames[i + 2].tokens : undefined

  const out: Record<string, FrameTokenState> = {}

  for (const tok of tokens) {
    const from = a[tok.id]
    const to = b[tok.id]
    if (from && to) {
      const p = curveBetween(before?.[tok.id], from, to, after?.[tok.id], frac)
      out[tok.id] = {
        // A curve can bulge past both of its waypoints, and the pitch is the
        // whole coordinate space, so the result is held inside it.
        x: clamp(p.x, 0, 100),
        y: clamp(p.y, 0, 100),
        rotation: lerp(from.rotation, to.rotation, frac),
      }
    } else {
      out[tok.id] = from ?? to ?? live[tok.id]
    }
  }
  return out
}

/** Total playback seconds for a sequence at the given per-frame duration. */
export const sequenceDuration = (frameCount: number, secondsPerFrame: number): number =>
  Math.max(0, frameCount - 1) * secondsPerFrame
