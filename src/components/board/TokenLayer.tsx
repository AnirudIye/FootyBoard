import { useBoardStore } from '../../store/boardStore'
import { useTokenTransition } from '../../hooks/useTokenTransition'
import { interpolateFrames } from '../../lib/frames'
import type { PitchMapping } from './pitchMapping'
import PlayerChip from './PlayerChip'
import BallToken from './BallToken'
import PropToken from './PropToken'

export default function TokenLayer({ mapping }: { mapping: PitchMapping }) {
  const tokens = useBoardStore((s) => s.tokens)
  const selection = useBoardStore((s) => s.selection)
  const formationEpoch = useBoardStore((s) => s.formationEpoch)
  const frames = useBoardStore((s) => s.frames)
  const playback = useBoardStore((s) => s.playback)
  const view = useBoardStore((s) => s.view)

  const travel = useTokenTransition(tokens, formationEpoch)
  const selected = new Set(selection)

  // Half views only show one half of the pitch. Off-half *players* are hidden
  // (they are formation context you manage from the picker), but the ball and
  // any props must stay reachable: clamp them to the visible edge so they can
  // always be grabbed and pulled back onto the field, never stranded off-view.
  const half: 'attack' | 'defend' | null =
    view.view === 'attackHalf' ? 'attack' : view.view === 'defendHalf' ? 'defend' : null

  const playerHidden = (nx: number): boolean => {
    if (half === 'attack') return nx < 48
    if (half === 'defend') return nx > 52
    return false
  }

  const clampIntoView = (nx: number): number => {
    if (half === 'attack') return Math.max(nx, 50.5)
    if (half === 'defend') return Math.min(nx, 49.5)
    return nx
  }

  // While the playhead is engaged, tokens follow the animation timeline; the
  // dashed selection ring is hidden so playback reads cleanly.
  const scrubbing = playback.position >= 0 && frames.length > 0
  const display = scrubbing
    ? interpolateFrames(frames, tokens, playback.position, playback.eased)
    : travel

  const scale = mapping.L / 105
  const chipR = mapping.ppm * 1.7 * scale
  const ballR = mapping.ppm * 0.95 * scale

  return (
    <>
      {tokens.map((t) => {
        const at = display[t.id] ?? { x: t.x, y: t.y }
        const isSel = !scrubbing && selected.has(t.id)
        if (t.type === 'player') {
          if (playerHidden(t.x)) return null
          return (
            <PlayerChip key={t.id} token={t} mapping={mapping} nx={at.x} ny={at.y} radius={chipR} selected={isSel} />
          )
        }
        // Ball and props stay reachable at the visible edge in half views.
        const nx = clampIntoView(at.x)
        if (t.type === 'ball') {
          return (
            <BallToken key={t.id} token={t} mapping={mapping} nx={nx} ny={at.y} radius={ballR} selected={isSel} />
          )
        }
        return <PropToken key={t.id} token={t} mapping={mapping} nx={nx} ny={at.y} selected={isSel} />
      })}
    </>
  )
}
