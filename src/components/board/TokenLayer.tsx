import { useBoardStore } from '../../store/boardStore'
import { useTokenTransition } from '../../hooks/useTokenTransition'
import { interpolateFrames } from '../../lib/frames'
import { playerHidden, shownX } from '../../lib/halves'
import type { PitchView, Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import PlayerChip from './PlayerChip'
import PropToken from './PropToken'

// The half rules themselves live in `src/lib/halves.ts`, because the drawing
// bands need the same halfway line these chips are judged against and a
// component file is a poor home for a rule three layers ask about. What stays
// here is what this layer drew: `onScreen` composes those rules for a token,
// and `lastDrawn` publishes the coordinates the render used.

/** Positions to draw at, keyed by token id: a tween, or a playback frame. */
export type DisplayPositions = Record<string, { x: number; y: number }>

/**
 * Where a token is on screen, and whether it is on screen at all.
 *
 * **One function, because the two questions are one question.** This layer used
 * to draw a chip at the tweened position and then decide whether to draw it at
 * all from the *stored* one, so a chip crossing the halfway line during playback
 * appeared or vanished a beat away from where it looked like it should. The
 * marquee had the same split from the other end: it hit-tested stored positions,
 * so you could rubber-band over a chip on screen and miss it. The two agreed with
 * each other and both disagreed with what a person could see.
 *
 * The fallback to the stored position is the ordinary case rather than an edge:
 * with no playback and no glide there is nothing in `display` at all.
 */
export function onScreen(
  view: PitchView,
  token: Token,
  display: DisplayPositions,
): { hidden: boolean; nx: number; ny: number } {
  const at = display[token.id] ?? { x: token.x, y: token.y }
  // Players off the shown half are formation context, managed from the picker.
  // A ball or prop is never hidden: one stranded off-view could never be pulled
  // back, so it is pinned to the visible edge instead.
  return token.type === 'player'
    ? { hidden: playerHidden(view, at.x), nx: at.x, ny: at.y }
    : { hidden: false, nx: shownX(view, at.x), ny: at.y }
}

/**
 * The positions the last render actually drew.
 *
 * The marquee needs the coordinates a person is looking at, and those come from
 * a tween this layer owns and from a playback interpolation only it computes.
 * Recomputing them in the canvas would mean two answers that have to agree, and
 * `useTokenTransition` is stateful, so a second call would be a second animation
 * with its own idea of where things are.
 *
 * So the layer publishes what it drew, and the marquee reads it. Assigned during
 * render, which is a side effect in render and worth naming as one: it is
 * idempotent, it is derived entirely from what is being returned below, and its
 * only reader runs on pointer-up, which is always after a paint. The same shape
 * as `boardHandles`, for the same reason.
 */
export const lastDrawn: { positions: DisplayPositions } = { positions: {} }

export default function TokenLayer({ mapping }: { mapping: PitchMapping }) {
  const tokens = useBoardStore((s) => s.tokens)
  const selection = useBoardStore((s) => s.selection)
  const formationEpoch = useBoardStore((s) => s.formationEpoch)
  const frames = useBoardStore((s) => s.frames)
  const playback = useBoardStore((s) => s.playback)
  const view = useBoardStore((s) => s.view)

  const travel = useTokenTransition(tokens, formationEpoch)
  const selected = new Set(selection)

  // While the playhead is engaged, tokens follow the animation timeline; the
  // dashed selection ring is hidden so playback reads cleanly.
  const scrubbing = playback.position >= 0 && frames.length > 0
  const display = scrubbing
    ? interpolateFrames(frames, tokens, playback.position, playback.eased)
    : travel

  const scale = mapping.L / 105
  const chipR = mapping.ppm * 1.7 * scale

  // Published for the marquee, so selection tests the coordinates this render
  // drew rather than a second opinion about them. See `lastDrawn`.
  lastDrawn.positions = display

  return (
    <>
      {tokens.map((t) => {
        const isSel = !scrubbing && selected.has(t.id)
        const { hidden, nx, ny } = onScreen(view.view, t, display)
        if (hidden) return null
        if (t.type === 'player') {
          return (
            <PlayerChip key={t.id} token={t} mapping={mapping} nx={nx} ny={ny} radius={chipR} selected={isSel} />
          )
        }
        return (
          <PropToken key={t.id} token={t} mapping={mapping} nx={nx} ny={ny} selected={isSel} />
        )
      })}
    </>
  )
}
