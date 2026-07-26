import { useRef } from 'react'
import { Group, Circle, Text, Line } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

const SELECT_RING = '#f4f2ef'

function pickText(hex: string): string {
  const c = hex.replace('#', '')
  if (c.length < 6) return '#fbf9f5'
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62 ? '#17191d' : '#fbf9f5'
}

interface Props {
  token: Token
  mapping: PitchMapping
  /** Position to draw at, which lags the store while chips are travelling. */
  nx: number
  ny: number
  radius: number
  selected: boolean
}

export default function PlayerChip({ token, mapping, nx: atX, ny: atY, radius, selected }: Props) {
  const moveToken = useBoardStore((s) => s.moveToken)
  const moveTokens = useBoardStore((s) => s.moveTokens)
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const openInspector = useBoardStore((s) => s.openInspector)
  const longPress = useRef<number | null>(null)

  const cancelLongPress = () => {
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current)
      longPress.current = null
    }
  }

  const pos = mapping.toPx(atX, atY)
  const textColor = pickText(token.color)
  const isKeeper = token.shape === 'keeper'
  const dragStart = useRef({ x: token.x, y: token.y })

  // Facing notch: a short beak at the rim showing body orientation.
  const rad = ((token.rotation - 90) * Math.PI) / 180
  const dirX = Math.cos(rad)
  const dirY = Math.sin(rad)
  const notch = [
    dirX * radius * 0.95,
    dirY * radius * 0.95,
    dirX * (radius + radius * 0.5),
    dirY * (radius + radius * 0.5),
  ]

  return (
    <Group
      x={pos.x}
      y={pos.y}
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
        // Long-press opens the inspector on touch, where there is no right-click.
        const { clientX, clientY } = e.evt
        cancelLongPress()
        longPress.current = window.setTimeout(() => {
          setSelection([token.id])
          openInspector(token.id, clientX, clientY)
        }, 500)
      }}
      onPointerUp={cancelLongPress}
      onDragStart={() => {
        cancelLongPress()
        dragStart.current = { x: token.x, y: token.y }
      }}
      onDragMove={(e) => {
        const n = mapping.toNorm(e.target.x(), e.target.y())
        const sel = useBoardStore.getState().selection
        if (selected && sel.length > 1) {
          const dx = n.x - dragStart.current.x
          const dy = n.y - dragStart.current.y
          dragStart.current = { x: n.x, y: n.y }
          moveTokens(
            sel.filter((id) => id !== token.id),
            dx,
            dy,
          )
          moveToken(token.id, n.x, n.y)
        } else {
          moveToken(token.id, n.x, n.y)
        }
      }}
      onDragEnd={() => commit()}
    >
      {selected && (
        <Circle
          radius={radius + 4}
          stroke={SELECT_RING}
          strokeWidth={1.5}
          dash={[3, 3]}
          opacity={0.85}
          listening={false}
        />
      )}
      {/* Body orientation is only worth showing once it has been set. */}
      {token.rotation !== 0 && (
        <Line points={notch} stroke={token.color} strokeWidth={radius * 0.3} lineCap="round" listening={false} />
      )}
      <Circle radius={radius} fill={token.color} stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
      {isKeeper && (
        <Circle
          radius={radius * 0.62}
          stroke={textColor}
          strokeWidth={1.2}
          opacity={0.7}
          listening={false}
        />
      )}
      <Text
        text={String(token.number ?? '')}
        x={-radius}
        y={-radius * 0.56}
        width={radius * 2}
        align="center"
        fontSize={radius * 1.05}
        fontStyle="500"
        fontFamily="IBM Plex Mono, monospace"
        fill={textColor}
        listening={false}
      />
      {token.label && (
        <Text
          text={token.label}
          x={-radius * 2.4}
          y={radius + 3}
          width={radius * 4.8}
          align="center"
          fontSize={radius * 0.66}
          fontFamily="Archivo, sans-serif"
          fill="#f0ece2"
          listening={false}
        />
      )}
    </Group>
  )
}
