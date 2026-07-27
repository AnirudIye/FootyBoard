import { Group, Line, Rect, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import { useTokenDrag } from './useTokenDrag'

const SELECT_INK = '#f4f2ef'

interface Props {
  token: Token
  mapping: PitchMapping
  nx: number
  ny: number
  selected: boolean
}

/**
 * Everything on the board that is not a player: the ball, and training props
 * (cones, poles, mini-goals, mannequins and directional markers). Sized from
 * the pitch so they stay proportional at any format.
 *
 * The ball used to have its own component, which was this one's Group, drag and
 * selection scaffolding written out a second time.
 */
export default function PropToken({ token, mapping, nx: atX, ny: atY, selected }: Props) {
  const moveToken = useBoardStore((s) => s.moveToken)
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const openInspector = useBoardStore((s) => s.openInspector)

  const u = mapping.ppm * (mapping.L / 105)
  const color = token.color
  const ballR = 0.95 * u
  const isBall = token.type === 'ball'

  const drag = useTokenDrag(mapping, isBall ? ballR : 2 * u)
  const pos = drag.place(mapping.toPx(atX, atY))

  const body = () => {
    switch (token.type) {
      case 'ball':
        return (
          <>
            <Circle
              ref={drag.bodyRef}
              radius={ballR}
              fill={color}
              stroke="#17191d"
              strokeWidth={1}
              opacity={0.96}
            />
            <Circle radius={ballR * 0.4} fill="#17191d" opacity={0.75} listening={false} />
          </>
        )
      case 'cone':
        return (
          <Line
            ref={drag.bodyRef}
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
              ref={drag.bodyRef}
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
            ref={drag.bodyRef}
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
              ref={drag.bodyRef}
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
              ref={drag.bodyRef}
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
      ref={drag.ref}
      x={pos.x}
      y={pos.y}
      rotation={token.rotation}
      draggable
      dragBoundFunc={drag.dragBoundFunc}
      onContextMenu={(e) => {
        e.evt.preventDefault()
        setSelection([token.id])
        openInspector(token.id, e.evt.clientX, e.evt.clientY)
      }}
      onPointerDown={(e) => {
        if (e.evt.button !== 0) return
        if (e.evt.shiftKey) toggleSelection(token.id)
        else if (!selected) setSelection([token.id])
        drag.pickUp()
      }}
      onPointerUp={() => drag.putDown()}
      onDragStart={() => drag.beginDrag()}
      onDragMove={(e) => {
        const n = mapping.toNorm(e.target.x(), e.target.y())
        moveToken(token.id, n.x, n.y)
      }}
      onDragEnd={() => {
        commit()
        // Home is wherever the store settled, which is the clamped position the
        // rest of the room has: the give was never anything but a view.
        const at = useBoardStore.getState().tokens.find((t) => t.id === token.id)
        drag.endDrag(mapping.toPx(at?.x ?? token.x, at?.y ?? token.y))
      }}
    >
      {selected && (
        <Circle
          radius={isBall ? ballR + 3.5 : 3.1 * u}
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
