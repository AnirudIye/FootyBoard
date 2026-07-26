import { Group, Line, Rect, Ellipse, Text, Circle } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { arrowHead, quadraticPoints, bboxOf } from '../../lib/geometry'
import type { Drawing } from '../../lib/types'
import type { PitchMapping } from './pitchMapping'

const SELECT_INK = '#f4f2ef'

interface Props {
  drawing: Drawing
  mapping: PitchMapping
  selected: boolean
}

export default function DrawingShape({ drawing: d, mapping: m, selected }: Props) {
  const setSelection = useBoardStore((s) => s.setSelection)
  const toggleSelection = useBoardStore((s) => s.toggleSelection)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)

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
    case 'pen':
      return (
        <Group>
          <Line points={mapped} tension={0.35} {...common} />
          {selectionOutline()}
        </Group>
      )

    case 'line':
      return (
        <Group>
          <Line points={mapped} {...common} />
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

    case 'zonePoly':
      return (
        <Group>
          <Line points={mapped} closed fill={d.color} opacity={d.fillOpacity ?? 0.18} {...common} />
          {selectionOutline()}
        </Group>
      )

    case 'text': {
      const [x, y] = mapped
      // Labels are sized off the pitch, not the stroke weight, so they stay
      // readable at every format and zoom level.
      const size = Math.max(11, m.ppm * (m.L / 105) * (0.9 + d.thickness * 0.35))
      return (
        <Group>
          <Text
            x={x}
            y={y}
            text={d.text ?? ''}
            fontSize={size}
            fontFamily="Archivo, sans-serif"
            fontStyle="500"
            fill={d.color}
            onPointerDown={common.onPointerDown}
          />
          {selectionOutline()}
        </Group>
      )
    }

    default:
      return null
  }
}
