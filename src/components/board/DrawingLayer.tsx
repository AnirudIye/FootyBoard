import { useBoardStore } from '../../store/boardStore'
import type { Drawing, DrawingType } from '../../lib/types'
import DrawingShape from './DrawingShape'
import type { PitchMapping } from './pitchMapping'

/**
 * Renders the drawings belonging to one band of the stack. Zones sit under the
 * chips, marks and text above them, per the PRD layer order. Which band is the
 * caller's predicate, since the caller already has one.
 */
export default function DrawingLayer({
  mapping,
  test,
  onEditText,
}: {
  mapping: PitchMapping
  test: (type: DrawingType) => boolean
  /**
   * Reopen the typing box over a label. Passed only by the band that draws
   * text, and only while a label may be edited, so a shape that has no edit
   * path never carries a handler that would do nothing.
   */
  onEditText?: (drawing: Drawing, screenX: number, screenY: number) => void
}) {
  const drawings = useBoardStore((s) => s.drawings)
  const selection = useBoardStore((s) => s.selection)
  const selected = new Set(selection)

  return (
    <>
      {drawings
        .filter((d) => test(d.type))
        .map((d) => (
          <DrawingShape
            key={d.id}
            drawing={d}
            mapping={mapping}
            selected={selected.has(d.id)}
            onEditText={onEditText}
          />
        ))}
    </>
  )
}
