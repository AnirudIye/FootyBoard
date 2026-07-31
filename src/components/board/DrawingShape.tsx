import { Group, Line, Rect, Ellipse, Text, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { arrowHead, quadraticPoints, bboxOf, triangleCorners } from '../../lib/geometry'
import type { Drawing } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

const SELECT_INK = '#f4f2ef'

interface Props {
  drawing: Drawing
  mapping: PitchMapping
  selected: boolean
  /** See `DrawingLayer`. Absent for every kind but text, and while a tool is armed. */
  onEditText?: (drawing: Drawing, screenX: number, screenY: number) => void
}

export default function DrawingShape({ drawing: d, mapping: m, selected, onEditText }: Props) {
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)
  const commit = useBoardStore((s) => s.commit)

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
    hitStrokeWidth: Math.max(14, width * 4),
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
            <Circle
              x={c.x}
              y={c.y}
              radius={Math.max(4, width * 1.6)}
              fill="#fbf9f5"
              stroke={SELECT_INK}
              strokeWidth={1.2}
              draggable
              onDragMove={(e) => {
                const nrm = m.toNorm(e.target.x(), e.target.y())
                updateDrawing(d.id, { control: [nrm.x, nrm.y] })
              }}
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

    // Both are a closed run of corners filled at the zone opacity, and the only
    // difference is where the corners come from: a polygon stores every one of
    // them, a triangle stores the drag and grows its third. Sharing the branch
    // rather than copying six lines of `Line` props is the point — a fill or a
    // hit-area that only two of the three zones agreed on would be a bug nobody
    // would think to look for.
    case 'zoneTriangle':
    case 'zonePoly': {
      /**
       * A triangle stores its three corners, so it is a polygon that stopped at
       * three and there is nothing left here to tell them apart.
       *
       * It used to store the two points of a drag and grow its apex on the way
       * to the screen, which is what `triangleCorners` was for. Three clicks
       * replaced that, and with the corners actually in `points` the derivation
       * went with it.
       *
       * The four-number arm is a shim for boards drawn in the hours between the
       * two designs, before either had reached anybody. Nothing produces such a
       * shape now, and this can be deleted along with `triangleCorners` as soon
       * as the dev database is known not to hold one. Without it, an old
       * triangle renders as a stray two-point line rather than as a triangle,
       * which is the sort of quiet wrongness that is hard to trace back.
       */
      const corners =
        d.type === 'zoneTriangle' && mapped.length === 4
          ? triangleCorners(mapped[0], mapped[1], mapped[2], mapped[3])
          : mapped
      return (
        <Group>
          <Line points={corners} closed fill={d.color} opacity={d.fillOpacity ?? 0.18} {...common} />
          {selectionOutline()}
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
