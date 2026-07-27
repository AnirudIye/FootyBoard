import { useBoardStore } from '../../store/boardStore'
import { useTokenTransition } from '../../hooks/useTokenTransition'
import { interpolateFrames } from '../../lib/frames'
import type { PitchView } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import PlayerChip from './PlayerChip'
import PropToken from './PropToken'

// Half views only show one half of the pitch. Off-half *players* are hidden
// (they are formation context you manage from the picker), but the ball and
// any props must stay reachable: they are clamped to the visible edge so they
// can always be grabbed and pulled back onto the field, never stranded off-view.
//
// Both rules are exported because selection has to agree with them. A marquee
// working off raw stored positions caught players nobody could see, and missed
// props at the edge it had itself put there.

/** Which half a view shows, or null when the whole pitch is on screen. */
const halfShown = (view: PitchView): 'attack' | 'defend' | null =>
  view === 'attackHalf' ? 'attack' : view === 'defendHalf' ? 'defend' : null

/** Whether a player is off the shown half, and so not on screen at all. */
export const playerHidden = (view: PitchView, nx: number): boolean => {
  const half = halfShown(view)
  if (half === 'attack') return nx < 48
  if (half === 'defend') return nx > 52
  return false
}

/** Where a ball or prop is actually drawn, which is never outside the view. */
export const shownX = (view: PitchView, nx: number): number => {
  const half = halfShown(view)
  if (half === 'attack') return Math.max(nx, 50.5)
  if (half === 'defend') return Math.min(nx, 49.5)
  return nx
}

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

  return (
    <>
      {tokens.map((t) => {
        const at = display[t.id] ?? { x: t.x, y: t.y }
        const isSel = !scrubbing && selected.has(t.id)
        if (t.type === 'player') {
          if (playerHidden(view.view, t.x)) return null
          return (
            <PlayerChip key={t.id} token={t} mapping={mapping} nx={at.x} ny={at.y} radius={chipR} selected={isSel} />
          )
        }
        return (
          <PropToken
            key={t.id}
            token={t}
            mapping={mapping}
            nx={shownX(view.view, at.x)}
            ny={at.y}
            selected={isSel}
          />
        )
      })}
    </>
  )
}
