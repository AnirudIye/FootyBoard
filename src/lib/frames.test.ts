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

describe('sequenceDuration', () => {
  it('spans the gaps between frames', () => {
    expect(sequenceDuration(3, 1.2)).toBeCloseTo(2.4, 6)
    expect(sequenceDuration(1, 1.2)).toBe(0)
    expect(sequenceDuration(0, 1.2)).toBe(0)
  })
})
