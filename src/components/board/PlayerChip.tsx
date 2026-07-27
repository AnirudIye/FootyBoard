import { useRef } from 'react'
import { Group, Circle, Text, Line } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import { useTokenDrag } from './useTokenDrag'

const SELECT_RING = '#f4f2ef'
const INK_DARK = '#080A09'
const INK_LIGHT = '#FBF9F5'

/**
 * Which of the two inks reads on a given chip colour.
 *
 * WCAG relative luminance, on linearised channels: the gamma-encoded shortcut
 * this used to run put every default team colour a hair on the wrong side and
 * printed white at 1.66:1 on all of them. The threshold is where the two inks
 * contrast equally against the same background (L 0.9486 and L 0.00288 cross at
 * L 0.1798), so whichever side a colour falls, it gets the better of the two.
 */
const lin = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function pickText(hex: string): string {
  const c = hex.replace('#', '')
  // Three-digit hex doubles each channel; anything else is not a colour we can
  // read, and the light ink is the safer guess on this board's dark ground.
  const full = c.length === 3 ? c.replace(/./g, (d) => d + d) : c
  if (!/^[0-9a-f]{6}$/i.test(full)) return INK_LIGHT
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return lum > 0.18 ? INK_DARK : INK_LIGHT
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
  const drag = useTokenDrag(mapping, radius)

  const cancelLongPress = () => {
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current)
      longPress.current = null
    }
  }

  const pos = drag.place(mapping.toPx(atX, atY))
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
      ref={drag.ref}
      x={pos.x}
      y={pos.y}
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
        // Long-press opens the inspector on touch, where there is no right-click.
        const { clientX, clientY } = e.evt
        cancelLongPress()
        longPress.current = window.setTimeout(() => {
          setSelection([token.id])
          openInspector(token.id, clientX, clientY)
        }, 500)
      }}
      onPointerUp={() => {
        cancelLongPress()
        drag.putDown()
      }}
      onDragStart={() => {
        cancelLongPress()
        drag.beginDrag()
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
      <Circle ref={drag.bodyRef} radius={radius} fill={token.color} stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
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
          fontFamily="Geist Sans, ui-sans-serif, system-ui, sans-serif"
          fill="#f0ece2"
          listening={false}
        />
      )}
    </Group>
  )
}
