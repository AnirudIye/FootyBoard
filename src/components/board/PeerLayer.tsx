import { Group, Line, Text, Circle, Label, Tag } from 'react-konva'
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

/** A pointer, drawn as a path so it stays crisp at any zoom. */
const ARROW = [0, 0, 0, 14, 3.6, 10.6, 6.2, 15.4, 8.6, 14.2, 6.1, 9.6, 11, 9.2]

export default function PeerLayer({ mapping }: { mapping: PitchMapping }) {
  const peers = useRealtimeStore((s) => s.peers)
  const tokens = useBoardStore((s) => s.tokens)
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

        const p = mapping.toPx(peer.cursor.x, peer.cursor.y)
        return (
          <Group key={peer.id}>
            {rings}
            <Group x={p.x} y={p.y}>
              <Line points={ARROW} closed fill={color} stroke="#0a0b09" strokeWidth={1} />
              <Label x={12} y={14} opacity={0.95}>
                <Tag fill={color} cornerRadius={2} />
                <Text
                  text={peer.email.split('@')[0]}
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
