import { describe, it, expect } from 'vitest'
import { halfShown, playerHidden, shownX, drawingOffHalf, halfClip } from './halves'
import type { Drawing } from './types'
import { computeMapping, blendMappings } from '../components/board/pitchMapping'

/**
 * The halfway line, asserted without a canvas.
 *
 * Konva cannot mount in jsdom, so the rules that decide what a half view shows
 * are held here rather than through a rendered stage — the same reason `onScreen`
 * is exported from `TokenLayer` and `dragChip` from `PlayerChip`.
 *
 * These assertions of `playerHidden` and `shownX` came over from
 * `TokenLayer.test.ts` with the code. They belong beside `drawingOffHalf`
 * because the three share one line and one dead band, and a change to the band
 * that was made for drawings and not for chips would be exactly the kind of
 * disagreement this module exists to prevent.
 */

// A real `Drawing` rather than a cast, so a change to the type is a compile
// error here rather than a test that goes on asserting about a shape nothing
// makes.
const drawing = (points: number[], extra: Partial<Drawing> = {}): Drawing => ({
  id: 'd1',
  type: 'line',
  points,
  color: '#B4432E',
  thickness: 2,
  ...extra,
})

describe('which half a view shows', () => {
  it('names a half only for the two half views', () => {
    expect(halfShown('attackHalf')).toBe('attack')
    expect(halfShown('defendHalf')).toBe('defend')
    expect(halfShown('fullH')).toBeNull()
    expect(halfShown('fullV')).toBeNull()
    expect(halfShown('blank')).toBeNull()
  })
})

describe('the rules every layer shares', () => {
  it('shows the attacking half from the halfway line out', () => {
    expect(playerHidden('attackHalf', 47)).toBe(true)
    expect(playerHidden('attackHalf', 49)).toBe(false)
  })

  it('pins a prop inside whichever half is shown', () => {
    expect(shownX('attackHalf', 10)).toBe(50.5)
    expect(shownX('defendHalf', 90)).toBe(49.5)
    expect(shownX('fullH', 10)).toBe(10)
  })
})

describe('a drawing on the hidden half', () => {
  it('is hidden when every point is off the shown half', () => {
    // The defect this rule was written for: mapped through an unclamped `toPx`,
    // an arrow back here is painted on the canvas beside the pitch, not off the
    // end of it, so it is as visible as anything actually on the field.
    expect(drawingOffHalf('attackHalf', drawing([10, 50, 30, 60]))).toBe(true)
    expect(drawingOffHalf('defendHalf', drawing([70, 50, 90, 60]))).toBe(true)
  })

  it('is drawn when every point is on the shown half', () => {
    expect(drawingOffHalf('attackHalf', drawing([60, 50, 80, 60]))).toBe(false)
    expect(drawingOffHalf('defendHalf', drawing([20, 50, 40, 60]))).toBe(false)
  })

  it('is drawn when it straddles the line, because that half of it is clipped', () => {
    // Not hidden and not whole: the part on the far side is cut at the pitch
    // edge by `halfClip`, which is the only way an arrow across the halfway line
    // can read correctly on a half view.
    expect(drawingOffHalf('attackHalf', drawing([40, 50, 60, 50]))).toBe(false)
    expect(drawingOffHalf('defendHalf', drawing([40, 50, 60, 50]))).toBe(false)
  })

  it('is drawn when it sits exactly on the line, from either half', () => {
    // 50 is inside the 48/52 dead band, so a shape laid along the halfway line
    // belongs to both halves rather than falling out of both.
    const online = drawing([50, 20, 50, 80])
    expect(drawingOffHalf('attackHalf', online)).toBe(false)
    expect(drawingOffHalf('defendHalf', online)).toBe(false)
  })

  it('uses the same dead band a player does, so the two never disagree', () => {
    // An arrow from a defender at 49 must survive on the attacking half for as
    // long as the defender does, or the coach is left with a chip whose
    // instruction has gone missing.
    expect(playerHidden('attackHalf', 49)).toBe(false)
    expect(drawingOffHalf('attackHalf', drawing([49, 50, 47, 50]))).toBe(false)
    expect(drawingOffHalf('attackHalf', drawing([47, 50, 46, 50]))).toBe(true)
  })

  it('is drawn when only the control point reaches the shown half', () => {
    // Both ends are behind the halfway line, but the curve bows across it, and
    // the bow is on screen. Testing the points alone would take a visible arc
    // off the board.
    const bowed = drawing([20, 50, 30, 50], { type: 'curvePass', control: [80, 50] })
    expect(drawingOffHalf('attackHalf', bowed)).toBe(false)
  })

  it('still hides a curve whose control point is off the half as well', () => {
    const behind = drawing([20, 50, 30, 50], { type: 'curvePass', control: [25, 20] })
    expect(drawingOffHalf('attackHalf', behind)).toBe(true)
  })

  it('judges a one-point label by its one point', () => {
    expect(drawingOffHalf('attackHalf', drawing([20, 50], { type: 'text', text: 'press' }))).toBe(true)
    expect(drawingOffHalf('attackHalf', drawing([80, 50], { type: 'text', text: 'press' }))).toBe(false)
  })

  it('hides nothing on a view that shows the whole pitch', () => {
    const across = drawing([5, 50, 95, 50])
    expect(drawingOffHalf('fullH', across)).toBe(false)
    expect(drawingOffHalf('fullV', drawing([5, 50]))).toBe(false)
    expect(drawingOffHalf('blank', drawing([5, 50]))).toBe(false)
  })
})

/**
 * The clip, and the fact that it animates.
 *
 * This reaches into `pitchMapping` because the point of the assertion is that
 * the clip rectangle and the pixels being clipped come from one blended
 * mapping: `useAnimatedMapping` morphs the box during a view change, and a clip
 * taken from the *target* box instead would cut a straddling shape off half a
 * second before the pitch edge reached it. `pitchMapping` is pure, so this
 * costs no canvas.
 */
describe('clipping a half view to the pitch', () => {
  const full = computeMapping('fullH', '11', 1200, 700)
  const half = computeMapping('attackHalf', '11', 1200, 700)
  // Undefined would make a comparison silently pass, so an absent clip becomes
  // a NaN that fails every ordering assertion below.
  const left = (clip: ReturnType<typeof halfClip>) => clip.clipX ?? Number.NaN

  it('leaves the full, vertical and blank views unclipped', () => {
    // Annotations that spill past a touchline are legitimate on a whole pitch.
    expect(halfClip('fullH', full.box)).toEqual({})
    expect(halfClip('fullV', full.box)).toEqual({})
    expect(halfClip('blank', full.box)).toEqual({})
  })

  it('clips a half view to exactly the drawn pitch rectangle', () => {
    expect(halfClip('attackHalf', half.box)).toEqual({
      clipX: half.box.x,
      clipY: half.box.y,
      clipWidth: half.box.w,
      clipHeight: half.box.h,
    })
  })

  it('is what stops the hidden half being painted beside the pitch', () => {
    // The unclamped mapping, stated as a fact rather than assumed: x = 40 on the
    // attacking half lands to the *left* of the pitch box, on bare canvas.
    expect(half.toPx(40, 50).x).toBeLessThan(half.box.x)
  })

  it('travels with the box during a view change instead of snapping', () => {
    const mid = blendMappings(full, half, 0.5)
    const clip = halfClip(mid.view, mid.box)

    // Half way through the morph the clip is half way between the two boxes.
    expect(clip.clipX).toBeCloseTo((full.box.x + half.box.x) / 2)
    expect(clip.clipWidth).toBeCloseTo((full.box.w + half.box.w) / 2)

    // And the straddling point is still inside it, because the shape and the
    // edge are moving together. It leaves the pitch when the edge reaches it.
    expect(mid.toPx(40, 50).x).toBeGreaterThan(left(clip))

    const end = blendMappings(full, half, 1)
    expect(end.toPx(40, 50).x).toBeLessThan(left(halfClip(end.view, end.box)))
  })
})
