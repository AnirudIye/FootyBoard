import { useRef } from 'react'
import { Group, Circle, Text, Line } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'
import type { Token } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'
import { useTokenDrag } from './useTokenDrag'

const SELECT_RING = '#f4f2ef'

/**
 * How wide a chip's target has to be in CSS pixels, before the stage scale is
 * divided back out. `PropToken`'s figures, because a chip is the same kind of
 * thing: a single object you go and put your finger on.
 *
 * **44 is the app's floor, and on a phone it also happens to be about as much
 * as the pitch has room for.** A chip is drawn at `ppm * 1.7`, so on a 375px
 * phone with the chrome docked the pitch is 338px across and a chip is
 * **10.9px** — a quarter of the floor, and the smallest thing on the board a
 * finger is asked to hit. Two neighbours in a back four sit about 13.6m apart,
 * which on that pitch is **44px**, so a 44px target reaches the midpoint
 * between them.
 *
 * **In a crowd the targets do meet, and that was measured rather than reasoned
 * about.** Sweeping a tap across the halfway line in 2px steps gives bands of
 * exactly 44px for a chip standing alone and one merged run of 138px where
 * three stand close. The merge is not the failure it sounds like: reading which
 * shirt each tap selected shows every chip still owning a contiguous band
 * around its own centre, with a crisp boundary to its neighbour rather than one
 * chip reaching across another. Konva hands an overlap to the later shape in
 * the array rather than to the nearer one, so the bias is real, and at these
 * radii it is a few pixels of boundary rather than a chip swallowing its
 * neighbour. Raising the figure is what would turn that from a nuisance into
 * moving the wrong player, which a coach may not notice.
 */
const TARGET_COARSE = 44
const TARGET_FINE = 32

/** Air around the painted disc, as a fraction of its radius, before the floor. */
const GRAB_PAD = 0.3
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

interface Pt {
  x: number
  y: number
}

/**
 * One step of a chip drag, in board coordinates.
 *
 * A selection travels as one delta and the chip under the pointer is part of
 * that set. Handing the rest to `moveTokens` and the dragged chip separately to
 * `moveToken` is what used to destroy the shape at a touchline: `moveTokens`
 * clamps the delta once against the bounding box of the tokens it is given,
 * `moveToken` clamps a single chip against its own position, and two clamps
 * stop at two different moments. Dragging a back four at x = 8, 18, 28, 38 by
 * the chip at 38 left them on 0, 0, 10, 20, with the dragged chip stacked on
 * the leftmost defender, and dragging back out did not restore the spacing.
 *
 * Exported for the same reason `playerHidden` is: the rule is worth asserting
 * without a canvas to render it on.
 */
export function dragChip(tokenId: string, to: Pt, from: Pt, grouped: boolean): void {
  const st = useBoardStore.getState()
  if (grouped && st.selection.length > 1) {
    st.moveTokens(st.selection, to.x - from.x, to.y - from.y)
  } else {
    st.moveToken(tokenId, to.x, to.y)
  }
}

export default function PlayerChip({ token, mapping, nx: atX, ny: atY, radius, selected }: Props) {
  const commit = useBoardStore((s) => s.commit)
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const openInspector = useBoardStore((s) => s.openInspector)
  const longPress = useRef<number | null>(null)
  const drag = useTokenDrag(mapping, radius)
  // Pan and zoom scale the stage, so a length of `s` reaches the eye as
  // `s * zoom` CSS pixels and a target specified in pixels has to be divided
  // back. The same conversion `PropToken` and `DrawingShape` do.
  const zoom = useBoardStore((s) => s.zoom)
  const coarse = useCoarsePointer()
  const grabR = Math.max(radius * (1 + GRAB_PAD), (coarse ? TARGET_COARSE : TARGET_FINE) / 2 / zoom)

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
        // Same test as onPointerDown below: inspecting a chip that is already in
        // the selection must not collapse the group down to that one chip.
        if (!selected) setSelection([token.id])
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
          if (!selected) setSelection([token.id])
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
        dragChip(token.id, n, dragStart.current, selected)
        dragStart.current = { x: n.x, y: n.y }
      }}
      onDragEnd={() => {
        commit()
        // Home is wherever the store settled, which is the clamped position the
        // rest of the room has: the give was never anything but a view.
        const at = useBoardStore.getState().tokens.find((t) => t.id === token.id)
        drag.endDrag(mapping.toPx(at?.x ?? token.x, at?.y ?? token.y))
      }}
    >
      {/**
       * The target, which is four times the chip on a phone and invisible.
       *
       * Konva hit-tests the painted disc exactly, and the disc is 10.9px across
       * on a 375px phone — so before this, selecting or dragging a player there
       * meant landing inside a target a quarter the size of the one every
       * element control on the page is held to. It is a real `fill` at zero
       * opacity because Konva's hit graph honours `visible` and `listening` and
       * ignores `opacity`, the same trick `PropToken` uses.
       *
       * First in the group, so it sits *under* the paint: the visible disc,
       * the notch and the numerals all keep their own hits and this only
       * catches what would otherwise have missed entirely.
       */}
      <Circle radius={grabR} fill="#000" opacity={0} />
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
