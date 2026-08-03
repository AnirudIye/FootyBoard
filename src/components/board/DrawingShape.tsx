import { Group, Line, Rect, Ellipse, Text, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { useCoarsePointer } from '../../hooks/useCoarsePointer'
import { arrowHead, quadraticPoints, bboxOf, grabBox, triangleCorners } from '../../lib/geometry'
import type { Drawing } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

const SELECT_INK = '#f4f2ef'
/** The pale face every draggable handle on the board shares. */
const HANDLE_FILL = '#fbf9f5'

/**
 * How wide a corner handle has to be in CSS pixels for each kind of pointer,
 * before the stage scale is divided back out.
 *
 * 22 is half the 44px floor `src/index.css` puts under every control that is an
 * element, and taking half is deliberate rather than a shortfall. A triangle
 * carries three of these and a traced shape can carry thirty; at full finger
 * size they would merge into one mat of handles covering the very shape they
 * exist to let you adjust, and the shape itself has to stay draggable
 * underneath them. A corner is also a target approached with the pointer
 * already on the shape, which is a different problem from finding a cone on an
 * empty pitch — that is what `PropToken`'s 44 is for.
 */
const HANDLE_COARSE = 22
const HANDLE_FINE = 14

/**
 * How wide a text label's target has to be, in CSS pixels, before the stage
 * scale is divided back out.
 *
 * The full 44/32 rather than the halved pair above, and the difference is the
 * difference between the two things. A corner handle is one of up to thirty on
 * a shape the pointer is already resting on; a label is a single object you go
 * and find, so it takes `PropToken`'s figures and for `PropToken`'s reason.
 */
const LABEL_COARSE = 44
const LABEL_FINE = 32

/**
 * How wide the hit band along a stroke has to be, in CSS pixels, before the
 * stage scale is divided back out.
 *
 * The same pair `PropToken` gives its rotation ring, and for the argument
 * written there: a band running the length of a line is far easier to hit than
 * its width suggests, so it does not need a point target's 44. It needs more
 * than it had. `Math.max(14, width * 4)` was a flat 14 CSS pixels at every zoom
 * and every pitch format — under half the floor a finger is measured against,
 * and the thinnest mark on the board is a 1px line, so the band *was* the
 * target.
 *
 * **The proportional half stays and still wins for a heavy stroke.** A 6px
 * arrow at `width * 4` asks for 24 and gets it; the floor only decides for the
 * thin ones, which is the case it exists for.
 *
 * Measured on a 375px phone, tapping perpendicular to an arrow's shaft: the old
 * flat 14 reached **7px** either side and this reaches **14px**, which is the
 * doubling the numbers promise.
 *
 * **What it does not fix, so that nobody assumes it did:** a chip with an arrow
 * drawn from it cannot be selected by pressing the chip, because the marks band
 * paints above the tokens and the arrow's tail lies on the player. That was
 * already true at 14 — measured at both widths, and the chip loses either way —
 * so this widens an area that was already the arrow's rather than taking a new
 * one. It is the strongest argument for keeping this number off 44, and the
 * real fix is a z-order or an attachment rule rather than a smaller band.
 */
const BAND_COARSE = 28
const BAND_FINE = 18

interface Props {
  drawing: Drawing
  mapping: PitchMapping
  selected: boolean
  /**
   * See `DrawingLayer`: present exactly while `select` is the armed tool, and
   * absent for the bands that have nothing to do with it. Its *presence* is the
   * signal for two things here, the label editor and the corner handles.
   */
  onEditText?: (drawing: Drawing, screenX: number, screenY: number) => void
}

export default function DrawingShape({ drawing: d, mapping: m, selected, onEditText }: Props) {
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)
  const commit = useBoardStore((s) => s.commit)
  // Pan and zoom scale the whole stage, so a length of `s` in these coordinates
  // reaches the eye as `s * zoom` CSS pixels. A handle sized for a finger is
  // specified in pixels and divided back, the way `PropToken` sizes its grab
  // boxes, or corners would grow easy to catch as you zoom in and vanish as you
  // zoom out — which is exactly when a shape needs adjusting.
  const zoom = useBoardStore((s) => s.zoom)
  const coarse = useCoarsePointer()

  // Stroke weight tracks the pitch so annotations stay proportional at any zoom.
  const unit = Math.max(0.5, m.ppm * 0.13 * (m.L / 105))
  const width = d.thickness * unit
  const headSize = Math.max(width * 3, m.ppm * 1.1 * (m.L / 105))

  const px = (nx: number, ny: number) => m.toPx(nx, ny)
  const mapped: number[] = []
  for (let i = 0; i < d.points.length; i += 2) {
    const p = px(d.points[i], d.points[i + 1])
    mapped.push(p.x, p.y)
  }

  const onSelect = (shiftKey: boolean) => {
    if (shiftKey) toggleSelection(d.id)
    else setSelection([d.id])
  }

  const common = {
    stroke: d.color,
    strokeWidth: width,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
    /**
     * What a press has to land within to count as landing on this mark.
     *
     * **This is above the chips, which is what bounds how far it may go.** The
     * marks band paints over `TokenLayer`, so every pixel of band is a pixel
     * where a press selects the arrow instead of the player under it — and a
     * run arrow is very often drawn *from* a chip, so the tail sits exactly on
     * one. That is the reason this takes the band figures rather than the 44 a
     * label takes: the label is the top of its own band with nothing beneath it
     * worth grabbing, and an arrow is not.
     */
    hitStrokeWidth: Math.max((coarse ? BAND_COARSE : BAND_FINE) / zoom, width * 4),
    onPointerDown: (e: { evt: PointerEvent }) => {
      if (e.evt.button === 0) onSelect(e.evt.shiftKey)
    },
  }

  const selectionOutline = () => {
    if (!selected) return null
    const b = bboxOf(mapped)
    const pad = Math.max(6, width)
    return (
      <Rect
        x={b.x - pad}
        y={b.y - pad}
        width={b.w + pad * 2}
        height={b.h + pad * 2}
        stroke={SELECT_INK}
        strokeWidth={1}
        dash={[4, 3]}
        opacity={0.6}
        listening={false}
      />
    )
  }

  /**
   * A draggable dot on every stored corner, for the two zones whose corners are
   * what they store.
   *
   * These are what make the Triangle and the Shape tools forgiving. A drag
   * plants a shape roughly and a corner then goes where it was meant, instead
   * of the coach deleting the whole thing and aiming again — which was the only
   * remedy either tool had.
   *
   * Sized like the painted stroke, then floored at a target a pointer can
   * actually hit; `Math.max` rather than a swap so a thick shape's handles are
   * never smaller than its own line, the same bargain `grabBox` strikes.
   */
  const cornerHandles = () => {
    const r = Math.max(width * 1.6, (coarse ? HANDLE_COARSE : HANDLE_FINE) / 2 / zoom)
    const out = []
    for (let i = 0; i < mapped.length; i += 2) {
      out.push(
        <Circle
          key={i}
          x={mapped[i]}
          y={mapped[i + 1]}
          radius={r}
          fill={HANDLE_FILL}
          stroke={SELECT_INK}
          strokeWidth={1.2}
          draggable
          /**
           * Konva has already moved the handle, so this writes where it landed
           * back to the store as that one corner. Deferred, so a whole
           * adjustment is one undo step rather than one per frame, and
           * `commit()` closes the run when the drag ends — the same convention
           * the label drag uses, for the same reason. `defer` holds only the
           * history push, so a peer still watches the corner move continuously.
           */
          onDragMove={(e) => {
            const n = m.toNorm(e.target.x(), e.target.y())
            const points = [...d.points]
            points[i] = n.x
            points[i + 1] = n.y
            updateDrawing(d.id, { points }, true)
          }}
          onDragEnd={() => commit()}
        />,
      )
    }
    return out
  }

  switch (d.type) {
    // A pen stroke is a line through many points with the corners taken off.
    case 'pen':
    case 'line':
      return (
        <Group>
          <Line points={mapped} tension={d.type === 'pen' ? 0.35 : undefined} {...common} />
          {selectionOutline()}
        </Group>
      )

    case 'arrow':
    case 'dashedArrow': {
      const [x0, y0, x1, y1] = mapped
      const head = arrowHead(x0, y0, x1, y1, headSize)
      return (
        <Group>
          <Line points={mapped} dash={d.dashed ? [headSize * 0.7, headSize * 0.5] : undefined} {...common} />
          <Line points={[head[0], head[1], x1, y1, head[2], head[3]]} {...common} dash={undefined} />
          {selectionOutline()}
        </Group>
      )
    }

    case 'curveArrow':
    case 'curvePass': {
      const [x0, y0, x1, y1] = mapped
      const c = d.control ? px(d.control[0], d.control[1]) : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      const curve = quadraticPoints(x0, y0, c.x, c.y, x1, y1, 24)
      // Aim the head along the final segment of the curve.
      const n = curve.length
      const head = arrowHead(curve[n - 4], curve[n - 3], x1, y1, headSize)
      return (
        <Group>
          <Line
            points={curve}
            dash={d.dashed ? [headSize * 0.7, headSize * 0.5] : undefined}
            {...common}
          />
          <Line points={[head[0], head[1], x1, y1, head[2], head[3]]} {...common} dash={undefined} />
          {selected && (
            /**
             * The bend handle, sized and committed like the corner handles it
             * sits beside rather than like the four-pixel dot it used to be.
             *
             * It was `Math.max(4, width * 1.6)` with no pointer kind and no
             * `/zoom`, which made it the one draggable handle on the board that
             * a finger could not reliably catch and the one that shrank as you
             * zoomed out — exactly when a curve most needs re-aiming. Same
             * floor as `cornerHandles` now, for the same reasons written there.
             *
             * And the drag is deferred. Every pointer move used to push its own
             * undo step and `structuredClone` the whole board with it, so undo
             * walked a bend back a few pixels at a time; `defer` holds the step
             * open and `commit()` closes it, while the `set` and the `emit`
             * still run per move so peers watch the curve bend continuously.
             * That is `updateDrawing`'s own convention and this was the last
             * gesture in the file not following it.
             */
            <Circle
              x={c.x}
              y={c.y}
              radius={Math.max(width * 1.6, (coarse ? HANDLE_COARSE : HANDLE_FINE) / 2 / zoom)}
              fill={HANDLE_FILL}
              stroke={SELECT_INK}
              strokeWidth={1.2}
              draggable
              onDragMove={(e) => {
                const nrm = m.toNorm(e.target.x(), e.target.y())
                updateDrawing(d.id, { control: [nrm.x, nrm.y] }, true)
              }}
              onDragEnd={() => commit()}
            />
          )}
          {selectionOutline()}
        </Group>
      )
    }

    case 'zoneRect': {
      const [x0, y0, x1, y1] = mapped
      return (
        <Group>
          <Rect
            x={Math.min(x0, x1)}
            y={Math.min(y0, y1)}
            width={Math.abs(x1 - x0)}
            height={Math.abs(y1 - y0)}
            fill={d.color}
            opacity={d.fillOpacity ?? 0.18}
            {...common}
          />
          {selectionOutline()}
        </Group>
      )
    }

    case 'zoneEllipse': {
      const [x0, y0, x1, y1] = mapped
      return (
        <Group>
          <Ellipse
            x={(x0 + x1) / 2}
            y={(y0 + y1) / 2}
            radiusX={Math.abs(x1 - x0) / 2}
            radiusY={Math.abs(y1 - y0) / 2}
            fill={d.color}
            opacity={d.fillOpacity ?? 0.18}
            {...common}
          />
          {selectionOutline()}
        </Group>
      )
    }

    // Both are a closed run of corners filled at the zone opacity, and both now
    // store those corners outright: a triangle is three of them, planted by a
    // drag that puts the apex under the press and grows the base away from it,
    // and a polygon is as many as were traced or clicked. Sharing the branch
    // rather than copying six lines of `Line` props is the point — a fill or a
    // hit-area that only two of the three zones agreed on would be a bug nobody
    // would think to look for.
    case 'zoneTriangle':
    case 'zonePoly': {
      /**
       * With the corners actually in `points` there is nothing left here to
       * tell a triangle from a polygon, and a handle drawn on a corner can drag
       * the very number it is drawn on.
       *
       * The four-number arm is a shim for boards drawn in the hours when a
       * triangle stored the two ends of a drag and grew its apex on the way to
       * the screen; `triangleCorners` is that derivation, and `erase.ts` calls
       * it for the same reason from the other side, so that such a shape can be
       * rubbed out as the triangle it is painted as. Nothing produces one now,
       * and all three can go as soon as the dev database is known not to hold
       * one. Without it an old triangle
       * renders as a stray two-point line, which is the sort of quiet wrongness
       * that is hard to trace back.
       */
      const legacy = d.type === 'zoneTriangle' && mapped.length === 4
      const corners = legacy
        ? triangleCorners(mapped[0], mapped[1], mapped[2], mapped[3])
        : mapped
      /**
       * Corner handles, gated on the same single signal the label editor is
       * gated on: `DrawingLayer` passes `onEditText` only while `select` is the
       * armed tool, so its presence is what says a press on this shape means
       * "adjust it" rather than "start drawing here". A second prop saying the
       * same thing is a second prop that can disagree with the first.
       *
       * **A legacy four-number triangle deliberately gets none.** Its stored
       * pair is a drag, not corners, so a handle on `points` would sit
       * somewhere that is not a corner of the shape on screen, and a handle on
       * the derived corners would have to write six numbers back — quietly
       * changing the shape's stored form under a gesture the coach thought was
       * a nudge, and adding a third state ("four numbers, unless somebody
       * touched it") to a shim that exists to be deleted. Such a triangle still
       * selects, moves, recolours and deletes exactly as it did; only the
       * corner-nudging is missing, and redrawing it is cheaper than carrying an
       * upgrade path for shapes that may not exist.
       */
      const handles = selected && onEditText && !legacy ? cornerHandles() : null
      return (
        <Group>
          <Line points={corners} closed fill={d.color} opacity={d.fillOpacity ?? 0.18} {...common} />
          {selectionOutline()}
          {handles}
        </Group>
      )
    }

    case 'text': {
      const [x, y] = mapped
      // Labels are sized off the pitch, not the stroke weight, so they stay
      // readable at every format and zoom level.
      const size = Math.max(11, m.ppm * (m.L / 105) * (0.9 + d.thickness * 0.35))
      /**
       * Double-click reopens the typing box over the label. It is the only
       * editable thing on a label that a style patch cannot reach: colour,
       * weight and attachment all go through `updateDrawing` already, and the
       * words did not, so a typo meant delete and retype.
       *
       * The box is positioned from the event rather than from `x`/`y`, because
       * those are stage coordinates under the current pan and zoom and the
       * input is a `fixed` DOM node that wants client ones.
       */
      const openEditor =
        onEditText &&
        ((e: { evt: MouseEvent | TouchEvent }) => {
          // A touch carries its coordinates one level down, and `changedTouches`
          // rather than `touches` because by the time the tap is recognised the
          // finger has already lifted and `touches` is empty.
          const at = 'changedTouches' in e.evt ? e.evt.changedTouches[0] : e.evt
          if (at) onEditText(d, at.clientX, at.clientY)
        })
      /**
       * Editing a label and moving one are the same gesture in one respect that
       * decides both: they are what a press on a label means *while `select` is
       * the tool*, and with a draw tool armed the same press means "start drawing
       * here". The layer passes `onEditText` only in select mode, so its presence
       * is the one signal for both rather than two props that could disagree.
       *
       * Konva's drag threshold is what keeps these two apart in practice: a
       * double-click that does not travel never becomes a drag.
       */
      const editable = onEditText !== undefined
      return (
        <Group>
          <Text
            x={x}
            y={y}
            text={d.text ?? ''}
            fontSize={size}
            fontFamily="Geist Sans, ui-sans-serif, system-ui, sans-serif"
            fontStyle="500"
            fill={d.color}
            /**
             * A target you can actually hit twice, which is what editing costs.
             *
             * Konva hit-tests a `Text` against its glyph box exactly, and this
             * node is the one shape on the board that never took `common`'s
             * `hitStrokeWidth` — it borrows only the press handler. The label's
             * size comes off the pitch and floors at 11px, so on a 375px phone
             * the whole target is an 11px-tall strip. **Dragging needs one
             * landing inside it and editing needs two inside 400ms**, which is
             * exactly why a label could be placed and moved but not reopened,
             * and why it felt intermittent rather than broken. Measured before
             * this: of six offsets within 18px of the anchor, three missed
             * entirely — no `pointerdown`, no `dbltap`, nothing to debug.
             *
             * `grabBox` is the same helper `PropToken` uses and the floor is the
             * same 44/32, not the halved 22/14 the corner handles take. A
             * corner is one of thirty vertices approached with the pointer
             * already on the shape; a label is a single thing you go and find on
             * an empty pitch, which is the case the full target is for.
             *
             * **What it costs, stated because it is a real trade:** the text
             * band paints above the tokens, so this invisible box can take a
             * press meant for a chip behind the words. It is bounded — the box
             * is the words' own width, only the height is forced up — and the
             * alternative was a label that cannot be edited on a phone at all.
             */
            hitFunc={(ctx, shape) => {
              const target = (coarse ? LABEL_COARSE : LABEL_FINE) / zoom
              const b = grabBox(
                { x: 0, y: 0, w: shape.width(), h: shape.height() },
                size * 0.25,
                target,
              )
              ctx.beginPath()
              ctx.rect(b.x, b.y, b.w, b.h)
              ctx.closePath()
              ctx.fillStrokeShape(shape)
            }}
            onPointerDown={common.onPointerDown}
            onDblClick={openEditor || undefined}
            onDblTap={openEditor || undefined}
            draggable={editable}
            /**
             * Konva has already moved the node, so this writes where it landed
             * back to the store in pitch coordinates. Deferred, so the whole
             * drag is one undo step; `commit()` closes it when the drag ends.
             */
            onDragMove={(e) => {
              const n = m.toNorm(e.target.x(), e.target.y())
              updateDrawing(d.id, { points: [n.x, n.y] }, true)
            }}
            onDragEnd={() => commit()}
          />
          {selectionOutline()}
        </Group>
      )
    }

    default:
      return null
  }
}
