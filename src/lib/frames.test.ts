import { describe, it, expect } from 'vitest'
import { captureFrame, interpolateFrames, sequenceDuration } from './frames'
import type { Token, Frame } from './types'

const tok = (id: string, x: number, y: number, rotation = 0): Token => ({
  id,
  type: 'player',
  color: '#000',
  x,
  y,
  rotation,
})

const frame = (id: string, tokens: Record<string, { x: number; y: number; rotation: number }>): Frame => ({
  id,
  label: id,
  tokens,
})

describe('captureFrame', () => {
  it('snapshots every token position and rotation', () => {
    const snap = captureFrame([tok('a', 10, 20, 45), tok('b', 30, 40)])
    expect(snap).toEqual({
      a: { x: 10, y: 20, rotation: 45 },
      b: { x: 30, y: 40, rotation: 0 },
    })
  })
})

describe('interpolateFrames', () => {
  const tokens = [tok('a', 0, 0), tok('b', 0, 0)]
  const frames = [
    frame('f1', { a: { x: 0, y: 0, rotation: 0 }, b: { x: 10, y: 10, rotation: 0 } }),
    frame('f2', { a: { x: 100, y: 40, rotation: 90 }, b: { x: 10, y: 90, rotation: 0 } }),
  ]

  it('returns the first frame at t=0 and the last at t=max', () => {
    expect(interpolateFrames(frames, tokens, 0).a).toEqual({ x: 0, y: 0, rotation: 0 })
    expect(interpolateFrames(frames, tokens, 1).a).toEqual({ x: 100, y: 40, rotation: 90 })
  })

  it('interpolates linearly at the midpoint', () => {
    const mid = interpolateFrames(frames, tokens, 0.5).a
    expect(mid.x).toBeCloseTo(50, 6)
    expect(mid.y).toBeCloseTo(20, 6)
    expect(mid.rotation).toBeCloseTo(45, 6)
  })

  it('eased motion lags linear early on but agrees at the ends', () => {
    // A symmetric ease matches linear at the exact midpoint, so sample earlier.
    const linear = interpolateFrames(frames, tokens, 0.25, false).a
    const eased = interpolateFrames(frames, tokens, 0.25, true).a
    expect(eased.x).toBeLessThan(linear.x)
    expect(interpolateFrames(frames, tokens, 0, true).a.x).toBeCloseTo(0, 6)
    expect(interpolateFrames(frames, tokens, 1, true).a.x).toBeCloseTo(100, 6)
  })

  it('keeps a token that is absent from the frames at its live position', () => {
    const withProp = [...tokens, tok('cone', 55, 66)]
    const out = interpolateFrames(frames, withProp, 0.5)
    expect(out.cone).toEqual({ x: 55, y: 66, rotation: 0 })
  })

  it('handles a single frame by holding it', () => {
    const out = interpolateFrames([frames[0]], tokens, 0)
    expect(out.a).toEqual({ x: 0, y: 0, rotation: 0 })
  })

  it('falls back to live positions with no frames', () => {
    expect(interpolateFrames([], tokens, 0).a).toEqual({ x: 0, y: 0, rotation: 0 })
  })
})

describe('easing a multi-frame sequence', () => {
  // A straight run through four evenly spaced waypoints. Everything below is
  // about how the playhead moves along it, not where it goes.
  const straight = [0, 25, 50, 75, 100].map((x, i) =>
    frame(`f${i}`, { a: { x, y: 50, rotation: 0 } }),
  )
  const tokens = [tok('a', 0, 50)]
  const at = (t: number) => interpolateFrames(straight, tokens, t, true).a.x
  const speedAt = (t: number, h = 0.001) => (at(t + h) - at(t - h)) / (2 * h)

  it('does not stop at a waypoint the way per-segment easing did', () => {
    // The old code eased each segment separately, so every captured frame was
    // a full stop and a fresh start. Speed at an interior boundary is now the
    // same on both sides of it and nowhere near zero.
    const boundary = 2 // the middle of a four-segment sequence
    expect(speedAt(boundary - 0.05)).toBeCloseTo(speedAt(boundary + 0.05), 6)
    expect(speedAt(boundary)).toBeGreaterThan(10)
  })

  it('holds one speed through the middle and only ramps at the ends', () => {
    const middle = [speedAt(1.5), speedAt(2), speedAt(2.5)]
    for (const v of middle) expect(v).toBeCloseTo(middle[0], 6)
    // Starting from rest and coming to rest is the whole point of the toggle.
    expect(speedAt(0.02)).toBeLessThan(middle[0])
    expect(speedAt(3.98)).toBeLessThan(middle[0])
  })

  it('lands exactly on the first and last waypoints, with nothing past them', () => {
    expect(at(0)).toBeCloseTo(0, 6)
    expect(at(4)).toBeCloseTo(100, 6)
    for (let t = 0; t <= 4; t += 0.05) {
      expect(at(t)).toBeGreaterThanOrEqual(0)
      expect(at(t)).toBeLessThanOrEqual(100)
    }
  })

  it('leaves a two-frame sequence exactly as it was', () => {
    // One segment has no middle to hold, so the trapezoid collapses back to the
    // cubic ease-in-out that used to be applied per segment.
    const cubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const two = [frame('f1', { a: { x: 0, y: 0, rotation: 0 } }), frame('f2', { a: { x: 100, y: 40, rotation: 90 } })]
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const out = interpolateFrames(two, [tok('a', 0, 0)], t, true).a
      expect(out.x).toBeCloseTo(cubic(t) * 100, 6)
      expect(out.y).toBeCloseTo(cubic(t) * 40, 6)
    }
  })
})

describe('curving through waypoints', () => {
  const tokens = [tok('a', 0, 0)]

  it('rounds a waypoint instead of turning on the spot', () => {
    // A right-angled run: along the pitch, then square across it.
    const corner = [
      frame('f1', { a: { x: 20, y: 50, rotation: 0 } }),
      frame('f2', { a: { x: 50, y: 50, rotation: 0 } }),
      frame('f3', { a: { x: 50, y: 20, rotation: 0 } }),
    ]
    const velocity = (t: number, h = 0.002) => {
      const p0 = interpolateFrames(corner, tokens, t - h, false).a
      const p1 = interpolateFrames(corner, tokens, t + h, false).a
      return { x: (p1.x - p0.x) / (2 * h), y: (p1.y - p0.y) / (2 * h) }
    }

    const before = velocity(0.98)
    const after = velocity(1.02)

    // A straight lerp gives (+x, 0) then (0, -y): a right angle turned in a
    // single tick. Here the player has begun turning before the waypoint and is
    // still carrying forward after it.
    expect(before.y).toBeLessThan(-1)
    expect(after.x).toBeGreaterThan(1)
    const heading = (v: { x: number; y: number }) => Math.atan2(v.y, v.x)
    expect(Math.abs(heading(before) - heading(after))).toBeLessThan(0.25)
  })

  it('runs straight when the waypoints are straight', () => {
    const straight = [0, 25, 50, 75].map((x, i) => frame(`f${i}`, { a: { x, y: 50, rotation: 0 } }))
    for (const t of [0.3, 1.4, 2.7]) {
      const out = interpolateFrames(straight, tokens, t, false).a
      expect(out.x).toBeCloseTo(25 * t, 6)
      expect(out.y).toBeCloseTo(50, 6)
    }
  })

  it('does not overshoot a turn made against the touchline', () => {
    // Out to the far line and back is the shape that makes a spline bulge past
    // its own waypoints, and past this one is off the pitch.
    const outAndBack = [
      frame('f1', { a: { x: 0, y: 50, rotation: 0 } }),
      frame('f2', { a: { x: 100, y: 50, rotation: 0 } }),
      frame('f3', { a: { x: 50, y: 50, rotation: 0 } }),
    ]
    for (let t = 0; t <= 2; t += 0.01) {
      const out = interpolateFrames(outAndBack, tokens, t, true).a
      expect(out.x).toBeGreaterThanOrEqual(0)
      expect(out.x).toBeLessThanOrEqual(100)
    }
  })
})

describe('sequenceDuration', () => {
  it('spans the gaps between frames', () => {
    expect(sequenceDuration(3, 1.2)).toBeCloseTo(2.4, 6)
    expect(sequenceDuration(1, 1.2)).toBe(0)
    expect(sequenceDuration(0, 1.2)).toBe(0)
  })
})
