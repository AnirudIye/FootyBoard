import { describe, it, expect } from 'vitest'
import { clampNorm, dist, arrowHead, quadraticPoints, bboxOf } from './geometry'

describe('geometry', () => {
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

describe('bboxOf', () => {
  it('bounds every point', () => {
    const box = bboxOf([10, 20, 40, 5, 25, 60])
    expect(box).toEqual({ x: 10, y: 5, w: 30, h: 55 })
  })
  it('handles a single point', () => {
    expect(bboxOf([7, 9])).toEqual({ x: 7, y: 9, w: 0, h: 0 })
  })
})
