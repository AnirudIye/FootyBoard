import { describe, it, expect } from 'vitest'
import {
  normToPx,
  pxToNorm,
  clampNorm,
  dist,
  arrowHead,
  quadraticPoints,
  pointNearSegment,
  bboxOf,
} from './geometry'

const box = { x: 100, y: 50, w: 1000, h: 600 }

describe('geometry', () => {
  it('maps norm to px within the box', () => {
    expect(normToPx(0, 0, box)).toEqual({ x: 100, y: 50 })
    expect(normToPx(100, 100, box)).toEqual({ x: 1100, y: 650 })
    expect(normToPx(50, 50, box)).toEqual({ x: 600, y: 350 })
  })
  it('round-trips px<->norm', () => {
    const p = normToPx(37, 82, box)
    const n = pxToNorm(p.x, p.y, box)
    expect(n.x).toBeCloseTo(37)
    expect(n.y).toBeCloseTo(82)
  })
  it('clamps norm coordinates to 0..100', () => {
    expect(clampNorm(-5, 120)).toEqual({ x: 0, y: 100 })
  })
  it('computes euclidean distance', () => {
    expect(dist(0, 0, 3, 4)).toBe(5)
  })
})

describe('arrowHead', () => {
  it('places both barbs behind the tip and symmetric about the shaft', () => {
    // Arrow pointing straight right, tip at (100, 0).
    const [ax, ay, bx, by] = arrowHead(0, 0, 100, 0, 10)
    expect(ax).toBeLessThan(100)
    expect(bx).toBeLessThan(100)
    expect(ax).toBeCloseTo(bx, 6)
    expect(ay).toBeCloseTo(-by, 6)
  })

  it('follows the direction of the shaft', () => {
    // Arrow pointing straight down, tip at (0, 100).
    const [ax, ay, bx, by] = arrowHead(0, 0, 0, 100, 10)
    expect(ay).toBeLessThan(100)
    expect(by).toBeLessThan(100)
    expect(ax).toBeCloseTo(-bx, 6)
  })

  it('returns the tip itself for a zero-length shaft', () => {
    const pts = arrowHead(50, 50, 50, 50, 10)
    expect(pts).toHaveLength(4)
    expect(pts.every((n) => Number.isFinite(n))).toBe(true)
  })
})

describe('quadraticPoints', () => {
  it('starts at the start and ends at the end', () => {
    const pts = quadraticPoints(0, 0, 50, 100, 100, 0, 16)
    expect(pts[0]).toBeCloseTo(0, 6)
    expect(pts[1]).toBeCloseTo(0, 6)
    expect(pts[pts.length - 2]).toBeCloseTo(100, 6)
    expect(pts[pts.length - 1]).toBeCloseTo(0, 6)
  })

  it('bulges toward the control point', () => {
    const pts = quadraticPoints(0, 0, 50, 100, 100, 0, 16)
    const midY = pts[pts.length / 2 + 1]
    expect(midY).toBeGreaterThan(20)
  })

  it('emits the requested number of samples', () => {
    expect(quadraticPoints(0, 0, 5, 5, 10, 0, 8)).toHaveLength((8 + 1) * 2)
  })
})

describe('pointNearSegment', () => {
  it('accepts a point sitting on the segment', () => {
    expect(pointNearSegment(50, 0, 0, 0, 100, 0, 2)).toBe(true)
  })
  it('accepts a point just off the segment within tolerance', () => {
    expect(pointNearSegment(50, 1.5, 0, 0, 100, 0, 2)).toBe(true)
  })
  it('rejects a point beyond tolerance', () => {
    expect(pointNearSegment(50, 20, 0, 0, 100, 0, 2)).toBe(false)
  })
  it('rejects a point past the end of the segment', () => {
    expect(pointNearSegment(200, 0, 0, 0, 100, 0, 2)).toBe(false)
  })
})

describe('bboxOf', () => {
  it('bounds every point', () => {
    const box = bboxOf([10, 20, 40, 5, 25, 60])
    expect(box).toEqual({ x: 10, y: 5, w: 30, h: 55 })
  })
  it('handles a single point', () => {
    expect(bboxOf([7, 9])).toEqual({ x: 7, y: 9, w: 0, h: 0 })
  })
})
