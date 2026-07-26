import { Group, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

interface Props {
  token: Token
  mapping: PitchMapping
  /** Position to draw at, which lags the store while tokens are travelling. */
  nx: number
  ny: number
  radius: number
  selected: boolean
}

export default function BallToken({ token, mapping, nx: atX, ny: atY, radius, selected }: Props) {
  const moveToken = useBoardStore((s) => s.moveToken)
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const pos = mapping.toPx(atX, atY)

  return (
    <Group
      x={pos.x}
      y={pos.y}
      draggable
      onPointerDown={(e) => {
        if (e.evt.button !== 0) return
        if (e.evt.shiftKey) toggleSelection(token.id)
        else if (!selected) setSelection([token.id])
      }}
      onDragMove={(e) => {
        const n = mapping.toNorm(e.target.x(), e.target.y())
        moveToken(token.id, n.x, n.y)
      }}
      onDragEnd={() => commit()}
    >
      {selected && (
        <Circle radius={radius + 3.5} stroke="#f4f2ef" strokeWidth={1.5} dash={[3, 3]} opacity={0.85} listening={false} />
      )}
      <Circle radius={radius} fill="#fbf9f5" stroke="#17191d" strokeWidth={1} opacity={0.96} />
      <Circle radius={radius * 0.4} fill="#17191d" opacity={0.75} listening={false} />
    </Group>
  )
}
