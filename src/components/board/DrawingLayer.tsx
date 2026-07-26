import { useBoardStore } from '../../store/boardStore'
import { isZone, isText, isMark } from '../../lib/drawings'
import DrawingShape from './DrawingShape'
import type { PitchMapping } from './pitchMapping'

export type DrawingLayerKind = 'zones' | 'marks' | 'text'

const matches: Record<DrawingLayerKind, (t: Parameters<typeof isZone>[0]) => boolean> = {
  zones: isZone,
  marks: isMark,
  text: isText,
}

/**
 * Renders the drawings belonging to one band of the stack. Zones sit under the
 * chips, marks and text above them, per the PRD layer order.
 */
export default function DrawingLayer({
  mapping,
  kind,
}: {
  mapping: PitchMapping
  kind: DrawingLayerKind
}) {
  const drawings = useBoardStore((s) => s.drawings)
  const selection = useBoardStore((s) => s.selection)
  const selected = new Set(selection)
  const test = matches[kind]

  return (
    <>
      {drawings
        .filter((d) => test(d.type))
        .map((d) => (
          <DrawingShape key={d.id} drawing={d} mapping={mapping} selected={selected.has(d.id)} />
        ))}
    </>
  )
}
