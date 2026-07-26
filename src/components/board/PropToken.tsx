import { Group, Line, Rect, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

const SELECT_INK = '#f4f2ef'

interface Props {
  token: Token
  mapping: PitchMapping
  nx: number
  ny: number
  selected: boolean
}

/**
 * Training props: cones, poles, mini-goals, mannequins and directional
 * markers. Sized from the pitch so they stay proportional at any format.
 */
export default function PropToken({ token, mapping, nx: atX, ny: atY, selected }: Props) {
  const moveToken = useBoardStore((s) => s.moveToken)
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const openInspector = useBoardStore((s) => s.openInspector)

  const pos = mapping.toPx(atX, atY)
  const u = mapping.ppm * (mapping.L / 105)
  const color = token.color

  const body = () => {
    switch (token.type) {
      case 'cone':
        return (
          <Line
            points={[0, -1.5 * u, 1.15 * u, 1.1 * u, -1.15 * u, 1.1 * u]}
            closed
            fill={color}
            stroke="rgba(0,0,0,0.4)"
            strokeWidth={1}
          />
        )
      case 'pole':
        return (
          <>
            <Rect
              x={-0.28 * u}
              y={-2.6 * u}
              width={0.56 * u}
              height={5.2 * u}
              fill={color}
              stroke="rgba(0,0,0,0.35)"
              strokeWidth={1}
              cornerRadius={0.28 * u}
            />
            <Circle y={2.7 * u} radius={0.5 * u} fill="rgba(0,0,0,0.25)" listening={false} />
          </>
        )
      case 'goal':
        return (
          <Line
            points={[-3 * u, 1 * u, -3 * u, -1 * u, 3 * u, -1 * u, 3 * u, 1 * u]}
            stroke={color}
            strokeWidth={Math.max(1.5, 0.34 * u)}
            lineCap="round"
            lineJoin="round"
          />
        )
      case 'mannequin':
        return (
          <>
            <Rect
              x={-0.85 * u}
              y={-1.1 * u}
              width={1.7 * u}
              height={3 * u}
              fill={color}
              stroke="rgba(0,0,0,0.4)"
              strokeWidth={1}
              cornerRadius={0.5 * u}
            />
            <Circle y={-1.9 * u} radius={0.75 * u} fill={color} stroke="rgba(0,0,0,0.4)" strokeWidth={1} />
          </>
        )
      case 'arrowMarker':
        return (
          <>
            <Line
              points={[-1.9 * u, 0, 1.4 * u, 0]}
              stroke={color}
              strokeWidth={Math.max(1.5, 0.36 * u)}
              lineCap="round"
            />
            <Line points={[0.5 * u, -0.95 * u, 2 * u, 0, 0.5 * u, 0.95 * u]} closed fill={color} />
          </>
        )
      default:
        return null
    }
  }

  return (
    <Group
      x={pos.x}
      y={pos.y}
      rotation={token.rotation}
      draggable
      onContextMenu={(e) => {
        e.evt.preventDefault()
        setSelection([token.id])
        openInspector(token.id, e.evt.clientX, e.evt.clientY)
      }}
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
        <Circle
          radius={3.1 * u}
          stroke={SELECT_INK}
          strokeWidth={1.5}
          dash={[3, 3]}
          opacity={0.8}
          listening={false}
        />
      )}
      {body()}
    </Group>
  )
}
