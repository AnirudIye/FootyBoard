import { describe, it, expect } from 'vitest'
import { onScreen, playerHidden, shownX, lastDrawn } from './TokenLayer'
import type { Token } from '../../lib/types'

/**
 * Where a token is decided to be, versus where it is drawn.
 *
 * `TokenLayer` drew a chip at the tweened position and then decided whether to
 * draw it at all from the *stored* one, so a chip crossing the halfway line
 * during playback appeared or vanished a beat away from where it looked like it
 * should. The marquee had the same split from the other side: it hit-tested
 * stored positions, so during playback you could rubber-band over a chip and miss
 * it, or catch one that was somewhere else on screen.
 *
 * The two were consistent with each other and both were consistent about the
 * wrong position, which is why this is one function now rather than two call
 * sites agreeing. "Can I see it" and "can I select it" are the same question
 * asked of the same coordinate.
 *
 * Tested here rather than through the canvas for the reason `dragChip` is
 * exported from `PlayerChip`: the rule is worth asserting without a Konva stage.
 */

// Real `Token`s rather than casts, so a change to the type is a compile error
// here rather than a test that goes on asserting about a shape nothing makes.
const player = (id: string, x: number): Token => ({
  id,
  type: 'player',
  teamId: 'home',
  number: 9,
  color: '#B4432E',
  shape: 'outfield',
  x,
  y: 50,
  rotation: 0,
})

const ball = (id: string, x: number): Token => ({
  id,
  type: 'ball',
  color: '#F2F6F1',
  x,
  y: 50,
  rotation: 0,
})

describe('what is on screen', () => {
  it('hides a player by where it is drawn, not where it is stored', () => {
    // The defect, in the one case that produced it. Attacking half shows x >= 48.
    // Stored at 20 (off the shown half) but animating through 80 (well on it):
    // the chip is visibly on the pitch, so it must not be treated as hidden.
    const t = player('p1', 20)
    const display = { p1: { x: 80, y: 50 } }

    expect(onScreen('attackHalf', t, display).hidden).toBe(false)
  })

  it('hides a player animating off the shown half, though it is stored on it', () => {
    // And the other direction, which is the same bug and would otherwise leave a
    // chip drawn outside the half the view is showing.
    const t = player('p1', 80)
    const display = { p1: { x: 20, y: 50 } }

    expect(onScreen('attackHalf', t, display).hidden).toBe(true)
  })

  it('reports the drawn position, so a hit test uses what a person sees', () => {
    const t = player('p1', 20)
    expect(onScreen('attackHalf', t, { p1: { x: 80, y: 40 } })).toMatchObject({ nx: 80, ny: 40 })
  })

  it('falls back to the stored position when nothing is being animated', () => {
    // The ordinary case: no playback, no glide, so there is no display entry and
    // stored is what is drawn.
    const t = player('p1', 20)
    expect(onScreen('attackHalf', t, {})).toMatchObject({ hidden: true, nx: 20 })
  })

  it('clamps a ball to the visible edge from its drawn position', () => {
    // Props are never hidden, because a ball stranded off-view could never be
    // pulled back. It is pinned to the edge instead, and that has to be computed
    // from where it is drawn or the clamp lags the animation.
    const t = ball('b1', 90)
    const at = onScreen('defendHalf', t, { b1: { x: 90, y: 50 } })

    expect(at.hidden).toBe(false)
    expect(at.nx).toBe(49.5)
  })

  it('hides nothing on a full view', () => {
    expect(onScreen('fullH', player('p1', 5), {}).hidden).toBe(false)
    expect(onScreen('fullH', ball('b1', 95), {}).nx).toBe(95)
  })
})

describe('the two rules it is built from', () => {
  // Kept exported and kept asserted: they are the halves `onScreen` composes,
  // and a change to either is a change to what a marquee catches.
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

describe('the positions the last render drew', () => {
  it('starts empty, so a marquee before the first paint reads stored positions', () => {
    // `lastDrawn` is how the marquee reaches the same coordinates the layer used.
    // Before anything has rendered it has to be empty rather than stale, or the
    // first gesture on a freshly opened board tests positions from the previous
    // one.
    expect(lastDrawn.positions).toEqual({})
  })
})
