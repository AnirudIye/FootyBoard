import { describe, it, expect } from 'vitest'
import { computeMapping, blendMappings } from './pitchMapping'

describe('computeMapping', () => {
  it('lays a full horizontal pitch out in landscape at the real aspect ratio', () => {
    const m = computeMapping('fullH', '11', 1200, 800)
    expect(m.orientation).toBe('h')
    expect(m.orientDeg).toBe(0)
    expect(m.box.w / m.box.h).toBeCloseTo(105 / 68, 2)
  })

  it('lays a full vertical pitch out in portrait', () => {
    const m = computeMapping('fullV', '11', 1200, 800)
    expect(m.orientation).toBe('v')
    expect(m.orientDeg).toBe(90)
    expect(m.box.w / m.box.h).toBeCloseTo(68 / 105, 2)
  })

  it('uses futsal proportions for a futsal pitch', () => {
    const m = computeMapping('fullH', 'futsal', 1200, 800)
    expect(m.box.w / m.box.h).toBeCloseTo(40 / 20, 2)
  })

  it('maps the pitch corners to the box corners horizontally', () => {
    const m = computeMapping('fullH', '11', 1200, 800)
    const tl = m.toPx(0, 0)
    const br = m.toPx(100, 100)
    expect(tl.x).toBeCloseTo(m.box.x, 3)
    expect(tl.y).toBeCloseTo(m.box.y, 3)
    expect(br.x).toBeCloseTo(m.box.x + m.box.w, 3)
    expect(br.y).toBeCloseTo(m.box.y + m.box.h, 3)
  })

  it('round-trips normalized coordinates through pixels', () => {
    for (const view of ['fullH', 'fullV', 'attackHalf'] as const) {
      const m = computeMapping(view, '11', 1200, 800)
      const back = m.toNorm(m.toPx(37, 82).x, m.toPx(37, 82).y)
      expect(back.x).toBeCloseTo(37, 3)
      expect(back.y).toBeCloseTo(82, 3)
    }
  })

  it('shows only the attacking half in the attackHalf view', () => {
    const m = computeMapping('attackHalf', '11', 1200, 800)
    // The halfway line sits at the left edge of the visible box.
    expect(m.toPx(50, 50).x).toBeCloseTo(m.box.x, 3)
    // The defensive half falls outside (to the left of) the box and is clipped.
    expect(m.toPx(0, 50).x).toBeLessThan(m.box.x)
  })
})

describe('blendMappings', () => {
  const a = computeMapping('fullH', '11', 1200, 800)
  const b = computeMapping('fullV', '11', 1200, 800)

  it('returns the endpoints exactly at t=0 and t=1', () => {
    expect(blendMappings(a, b, 0)).toBe(a)
    expect(blendMappings(a, b, 1)).toBe(b)
  })

  it('interpolates pixel positions halfway through the morph', () => {
    const mid = blendMappings(a, b, 0.5)
    const pa = a.toPx(25, 75)
    const pb = b.toPx(25, 75)
    const pm = mid.toPx(25, 75)
    expect(pm.x).toBeCloseTo((pa.x + pb.x) / 2, 3)
    expect(pm.y).toBeCloseTo((pa.y + pb.y) / 2, 3)
  })

  it('rotates direction-dependent detail smoothly', () => {
    expect(blendMappings(a, b, 0.5).orientDeg).toBeCloseTo(45, 3)
  })

  it('interpolates scale so markings resize with the pitch', () => {
    const mid = blendMappings(a, b, 0.5)
    expect(mid.ppm).toBeCloseTo((a.ppm + b.ppm) / 2, 3)
  })

  it('converts pointer positions using the target geometry', () => {
    const mid = blendMappings(a, b, 0.5)
    const q = b.toPx(60, 40)
    const n = mid.toNorm(q.x, q.y)
    expect(n.x).toBeCloseTo(60, 3)
    expect(n.y).toBeCloseTo(40, 3)
  })
})
