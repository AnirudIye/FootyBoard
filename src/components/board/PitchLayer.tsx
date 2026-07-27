import { Group, Line, Circle, Arc } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import type { PitchMapping } from './pitchMapping'

/**
 * Pitch markings are expressed in normalized pitch coordinates (0..100 along
 * the length, 0..100 across the width) and positioned through mapping.toPx.
 * That keeps every element correct under any orientation, view crop, or pitch
 * size, and lets the whole pitch morph smoothly when the mapping is blended.
 */
export default function PitchLayer({ mapping: m }: { mapping: PitchMapping }) {
  const view = useBoardStore((s) => s.view)
  const light = view.pitchTheme === 'light'

  const turf = light ? '#e9e5da' : '#2f4a3b'
  const turfAlt = light ? '#e4dfd2' : '#34513f'
  const lineColor = light ? '#3a3f45' : view.lineColor
  const lineOpacity = light ? 0.55 : 0.88
  const lineWidth = Math.max(1, m.ppm * 0.2)

  const { box, L, W } = m
  const s = L / 105 // scale real-pitch markings down for smaller formats
  const blank = view.view === 'blank'

  const p = (nx: number, ny: number) => m.toPx(nx, ny)
  const poly = (pts: [number, number][]) => pts.flatMap(([nx, ny]) => { const q = p(nx, ny); return [q.x, q.y] })

  // Marking dimensions converted to normalized pitch units.
  const penDepth = ((16.5 * s) / L) * 100
  const penHalfW = ((40.32 * s) / 2 / W) * 100
  const sixDepth = ((5.5 * s) / L) * 100
  const sixHalfW = ((18.32 * s) / 2 / W) * 100
  const penSpot = ((11 * s) / L) * 100
  const goalHalfW = ((7.32 * s) / 2 / W) * 100

  const centreR = m.ppm * 9.15 * s
  const arcR = m.ppm * 9.15 * s
  const cornerR = m.ppm * 1 * s
  const spotR = Math.max(1.2, m.ppm * 0.28 * s)

  const stroke = { stroke: lineColor, strokeWidth: lineWidth, opacity: lineOpacity }

  const nodes: React.ReactNode[] = []
  let k = 0
  const key = () => `m${k++}`

  // Mow stripes across the length of the pitch.
  if (view.grass) {
    const bands = 8
    for (let i = 0; i < bands; i++) {
      const a = (i / bands) * 100
      const b = ((i + 1) / bands) * 100
      nodes.push(
        <Line
          key={key()}
          points={poly([[a, 0], [b, 0], [b, 100], [a, 100]])}
          closed
          fill={i % 2 === 0 ? turf : turfAlt}
          listening={false}
        />,
      )
    }
  } else {
    nodes.push(
      <Line key={key()} points={poly([[0, 0], [100, 0], [100, 100], [0, 100]])} closed fill={turf} listening={false} />,
    )
  }

  if (!blank) {
    // Boundary
    nodes.push(<Line key={key()} points={poly([[0, 0], [100, 0], [100, 100], [0, 100]])} closed {...stroke} />)
    // Halfway line
    nodes.push(<Line key={key()} points={poly([[50, 0], [50, 100]])} {...stroke} />)

    // Centre circle and spot
    const centre = p(50, 50)
    nodes.push(<Circle key={key()} x={centre.x} y={centre.y} radius={centreR} {...stroke} />)
    nodes.push(<Circle key={key()} x={centre.x} y={centre.y} radius={spotR} fill={lineColor} opacity={lineOpacity} />)

    // Both ends
    for (const end of [0, 100] as const) {
      const dir = end === 0 ? 1 : -1

      // Penalty box and six-yard box: the same three-sided shape, twice.
      for (const [depth, halfW] of [
        [penDepth, penHalfW],
        [sixDepth, sixHalfW],
      ]) {
        const far = end + dir * depth
        nodes.push(
          <Line
            key={key()}
            points={poly([
              [end, 50 - halfW],
              [far, 50 - halfW],
              [far, 50 + halfW],
              [end, 50 + halfW],
            ])}
            {...stroke}
          />,
        )
      }

      const spot = p(end + dir * penSpot, 50)
      nodes.push(<Circle key={key()} x={spot.x} y={spot.y} radius={spotR} fill={lineColor} opacity={lineOpacity} />)

      // Penalty arc, rotating smoothly with the blended orientation.
      const base = (end === 0 ? 0 : 180) + m.orientDeg
      nodes.push(
        <Arc
          key={key()}
          x={spot.x}
          y={spot.y}
          innerRadius={arcR}
          outerRadius={arcR}
          angle={106}
          rotation={base - 53}
          {...stroke}
        />,
      )

      // Goal mouth, drawn heavier than the markings.
      nodes.push(
        <Line
          key={key()}
          points={poly([[end, 50 - goalHalfW], [end, 50 + goalHalfW]])}
          stroke={lineColor}
          strokeWidth={lineWidth * 2.4}
          opacity={lineOpacity}
        />,
      )
    }

    // Corner arcs. Rotations depend on how the corners land in pixel space,
    // which differs between orientations, so they follow the target.
    const cornerRots = m.orientation === 'v' ? [0, 270, 180, 90] : [0, 90, 180, 270]
    const cornerPts: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]]
    cornerPts.forEach((c, i) => {
      const q = p(c[0], c[1])
      nodes.push(
        <Arc
          key={key()}
          x={q.x}
          y={q.y}
          innerRadius={cornerR}
          outerRadius={cornerR}
          angle={90}
          rotation={cornerRots[i]}
          {...stroke}
        />,
      )
    })

    // Channels (5 across the width) and thirds (3 along the length).
    if (view.overlayGrid) {
      const guide = { stroke: lineColor, strokeWidth: 1, opacity: 0.28, dash: [5, 7] }
      for (let i = 1; i < 5; i++) {
        nodes.push(<Line key={key()} points={poly([[0, (100 / 5) * i], [100, (100 / 5) * i]])} {...guide} />)
      }
      for (let i = 1; i < 3; i++) {
        nodes.push(<Line key={key()} points={poly([[(100 / 3) * i, 0], [(100 / 3) * i, 100]])} {...guide} />)
      }
    }
  }

  return (
    <Group clipX={box.x} clipY={box.y} clipWidth={box.w} clipHeight={box.h}>
      {nodes}
    </Group>
  )
}
