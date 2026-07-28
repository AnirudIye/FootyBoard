import { Group, Path, Text, Circle, Label, Tag } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { useRealtimeStore, peerColor } from '../../store/realtimeStore'
import type { PitchMapping } from './pitchMapping'

/**
 * Everyone else's pointers and selections.
 *
 * Drawn above the board and never listening, so a peer's cursor can never
 * intercept a click meant for a chip underneath it. Nothing here is part of the
 * board: it is not saved, not exported, and not undoable.
 */

/**
 * The pointer silhouette, drawn from its tip at (0,0) so the peer's coordinate
 * is the point of the arrow rather than the corner of a box.
 *
 * A Path rather than a Line because every corner is rounded: the three points
 * (tip, right lobe, tail) and the notch between the last two are quadratic
 * fillets. That roundness has to live in the geometry — `lineJoin: 'round'`
 * only softens the stroke, and the fill underneath would keep its spikes, which
 * is exactly what makes the system arrow look like a system arrow.
 *
 * Units are screen pixels: the shape spans about 22 of them on each axis, and
 * the group that carries it is counter-scaled so it stays that size at any zoom.
 */
const CURSOR_PATH =
  'M 2.03 0.84 L 19.6 8.11 Q 22 9.1 19.52 9.88 L 15.06 11.3 Q 12.2 12.2 11.12 15 ' +
  'L 9.34 19.58 Q 8.4 22 7.47 19.57 L 0.78 2.06 Q 0 0 2.03 0.84 Z'

export default function PeerLayer({ mapping }: { mapping: PitchMapping }) {
  const peers = useRealtimeStore((s) => s.peers)
  const tokens = useBoardStore((s) => s.tokens)

  /**
   * PeerLayer sits inside the scaled stage, so everything drawn here zooms with
   * the board. A cursor is not a thing on the pitch, it is a piece of interface
   * about a person, so it has to hold one size on screen however far in or out
   * the board is: the pointer group is counter-scaled by 1/zoom, which cancels
   * the stage transform exactly.
   *
   * `zoom` is the stage's own scale, which PitchCanvas mirrors into the board
   * store. Reading it here is a subscription, so a zoom step re-renders this
   * layer; asking the Konva node for its scale would be the same number with no
   * way to know when it changed.
   */
  const zoom = useBoardStore((s) => s.zoom)
  const invZoom = 1 / (zoom || 1)

  const list = Object.values(peers)

  if (list.length === 0) return null

  // Matches TokenLayer's chip radius, so a ring sits exactly around what it marks.
  const chipRadius = mapping.ppm * 1.7

  return (
    <>
      {list.map((peer) => {
        const color = peerColor(peer.id)

        // A ring around what they have selected, so it is obvious who is about
        // to move what — the most useful thing to know in a shared room.
        const rings = peer.selection
          .map((id) => tokens.find((t) => t.id === id))
          .filter((t): t is NonNullable<typeof t> => Boolean(t))
          .map((token) => {
            const p = mapping.toPx(token.x, token.y)
            return (
              <Circle
                key={`${peer.id}-${token.id}`}
                x={p.x}
                y={p.y}
                radius={chipRadius + 4}
                stroke={color}
                strokeWidth={1.5}
                opacity={0.9}
              />
            )
          })

        if (!peer.cursor) return <Group key={peer.id}>{rings}</Group>

        // Always the display name, never the raw address: the store strips the
        // domain on the way in, and with anonymous guests on this is the animal
        // name instead. A screen-shared board should not put anyone's email on
        // the pitch.
        const name = peer.displayName

        const p = mapping.toPx(peer.cursor.x, peer.cursor.y)
        return (
          <Group key={peer.id}>
            {rings}
            <Group x={p.x} y={p.y} scaleX={invZoom} scaleY={invZoom}>
              <Path
                data={CURSOR_PATH}
                fill={color}
                stroke="#0a0b09"
                strokeWidth={1}
                lineJoin="round"
                // Per-peer hue does the identifying, so the pointer also needs
                // to read as an object above the pitch rather than a sticker on
                // it: a low, soft shadow lifts it off bright turf without
                // turning into a halo.
                shadowColor="#000000"
                shadowBlur={6}
                shadowOffsetX={1.5}
                shadowOffsetY={2.5}
                shadowOpacity={0.35}
              />
              <Label x={16} y={20} opacity={0.95}>
                <Tag fill={color} cornerRadius={3} />
                <Text
                  text={name}
                  fontSize={10}
                  fontFamily="IBM Plex Mono, monospace"
                  fill="#0a0b09"
                  padding={3}
                />
              </Label>
            </Group>
          </Group>
        )
      })}
    </>
  )
}
