import { describe, it, expect } from 'vitest'
import { computeMapping, blendMappings, boardPerPixel } from './pitchMapping'

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

/**
 * The bridge anything sized for a hand has to cross: CSS pixels, which is the
 * only unit a finger has, into board units, which is the only unit a drawing is
 * stored in.
 */
describe('boardPerPixel', () => {
  it('answers each screen axis separately, in the proportion of the pitch', () => {
    const m = computeMapping('fullH', '11', 1200, 800)
    const per = boardPerPixel(m, 1)
    // A board unit is a hundredth of 105m across and a hundredth of 68m down, so
    // one pixel is fewer units of the long axis than of the short one.
    expect(per.y / per.x).toBeCloseTo(105 / 68, 6)
  })

  /**
   * The trap this function exists for.
   *
   * On a vertical pitch a step along screen x moves the pointer across the
   * pitch's *width*, which the board calls y — so the obvious spelling,
   * `toNorm(px + 1, py).x - toNorm(px, py).x`, is not a different number here.
   * It is exactly nought, and anything sized from it would be sized at nothing.
   */
  it('keeps answering when the screen axes swap under a vertical pitch', () => {
    const m = computeMapping('fullV', '11', 1200, 800)
    expect(m.toNorm(1, 0).x - m.toNorm(0, 0).x).toBeCloseTo(0, 12)

    const per = boardPerPixel(m, 1)
    expect(per.x).toBeGreaterThan(0)
    expect(per.y).toBeGreaterThan(0)
    // Screen x runs across the width now, so it is the coarser of the two.
    expect(per.x / per.y).toBeCloseTo(105 / 68, 6)
  })

  it('shrinks with the zoom, so a thing sized in pixels keeps its size on screen', () => {
    const m = computeMapping('fullH', '11', 1200, 800)
    const one = boardPerPixel(m, 1)
    const two = boardPerPixel(m, 2)
    expect(two.x).toBeCloseTo(one.x / 2, 9)
    expect(two.y).toBeCloseTo(one.y / 2, 9)
  })

  it('comes back to the same distance in metres on any format', () => {
    // Board units mean different lengths on different pitches; the pixel does
    // not. A futsal court is drawn at its own scale, so the same pixel is many
    // more board units there and the same number of metres.
    const full = computeMapping('fullH', '11', 1200, 800)
    const futsal = computeMapping('fullH', 'futsal', 1200, 800)
    expect(boardPerPixel(full, 1).x * 1.05).toBeCloseTo(1 / full.ppm, 9)
    expect(boardPerPixel(futsal, 1).x * 0.4).toBeCloseTo(1 / futsal.ppm, 9)
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
