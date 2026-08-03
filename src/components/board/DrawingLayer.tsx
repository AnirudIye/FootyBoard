import { Group } from 'react-konva'
import { useBoardStore } from '../../store/boardStore'
import { drawingOffHalf, halfClip } from '../../lib/halves'
import type { Drawing, DrawingType } from '../../lib/types'
import DrawingShape from './DrawingShape'
import type { PitchMapping } from './pitchMapping'

/**
 * Renders the drawings belonging to one band of the stack. Zones sit under the
 * chips, marks and text above them, per the PRD layer order. Which band is the
 * caller's predicate, since the caller already has one.
 *
 * A half view is answered here rather than by the caller, because all three
 * bands need the same answer: a drawing entirely on the hidden half is dropped,
 * and one that straddles the halfway line is clipped to the pitch so the far
 * part is cut at the edge instead of painted on the canvas beside it. Without
 * this a drawing on the hidden half was mapped straight through an unclamped
 * `toPx` and landed outside the pitch box, fully visible. (The live draft
 * preview needs the same clip and cannot come through here, so `PitchCanvas`
 * applies `halfClip` to it directly.)
 *
 * The view is read off `mapping` rather than out of the store on purpose. On
 * the render where a view change begins, `useAnimatedMapping` deliberately
 * keeps returning the *old* geometry so the morph can start from what is on
 * screen; taking the view from the same object as the box means the rule and
 * the pixels it is applied to never describe two different views for that frame.
 */
export default function DrawingLayer({
  mapping,
  test,
  onEditText,
}: {
  mapping: PitchMapping
  test: (type: DrawingType) => boolean
  /**
   * Reopen the typing box over a label — and, by being present at all, the one
   * signal that `select` is the armed tool.
   *
   * `DrawingShape` reads it both ways: the text branch calls it, and the
   * triangle/polygon branch takes its presence as leave to draw corner handles,
   * because with a draw tool armed a press on a shape means "start drawing
   * here" instead. That is why the zone band is given it too although a zone
   * has no words to edit. One signal cannot disagree with itself the way two
   * props can, and this file has been through that once already.
   *
   * The band that draws marks is still given nothing, because nothing in it
   * consults either meaning.
   */
  onEditText?: (drawing: Drawing, screenX: number, screenY: number) => void
}) {
  const drawings = useBoardStore((s) => s.drawings)
  const selection = useBoardStore((s) => s.selection)
  const selected = new Set(selection)

  return (
    <Group {...halfClip(mapping.view, mapping.box)}>
      {drawings
        .filter((d) => test(d.type) && !drawingOffHalf(mapping.view, d))
        .map((d) => (
          <DrawingShape
            key={d.id}
            drawing={d}
            mapping={mapping}
            selected={selected.has(d.id)}
            onEditText={onEditText}
          />
        ))}
    </Group>
  )
}
